import { availableModelsForProvider } from './catalog-lookups.js';
import { MAX_BOUNCE_COUNT } from './constants.js';
import { convertPartToInput, pickReplayUserMessage } from './messages.js';
import {
  canonicalModelID,
  formatModel,
  getModelForProviderTier,
  inferTierFromModel,
  modelKey,
  pickFallback,
  providerChainSummary,
} from './models.js';
import {
  attemptedTargetsBySession,
  bounceCountBySession,
  clearStallWatchdog,
  getLastGlobalFailoverAt,
  getLastGlobalFailoverSessionID,
  lastFailoverMsBySession,
  lastTransitionBySession,
  pendingBySession,
  runtimeSettings,
  setLastGlobalFailoverAt,
  setLastGlobalFailoverSessionID,
} from './state.js';
import { logFailoverEvent } from './settings.js';
import {
  buildFailoverToastMessage,
  categorizeDispatchError,
  dispatchErrorHint,
  exactDispatchErrorReason,
  recordTrigger,
  showDebugTriggerToast,
  summarizeDispatchError,
} from './reporting.js';
import { armStallWatchdog } from './watchdog.js';
import type { KnownTier } from './types.js';

/** getAttemptedTargets does return per-session attempted model keys for a user message. */
export function getAttemptedTargets(sessionID: string, userMessageID: string): Set<string> {
  let sessionMap = attemptedTargetsBySession.get(sessionID) as Map<string, Set<string>> | undefined;
  if (!sessionMap) {
    sessionMap = new Map();
    attemptedTargetsBySession.set(sessionID, sessionMap);
  }
  let attemptedSet = sessionMap.get(userMessageID);
  if (!attemptedSet) {
    attemptedSet = new Set();
    sessionMap.set(userMessageID, attemptedSet);
  }
  return attemptedSet;
}

/** isWithinGlobalCooldown does gate failover dispatches by shared cooldown window. */
export function isWithinGlobalCooldown(sessionID: string): boolean {
  const cooldownMs = runtimeSettings.globalCooldownMs;
  if (!cooldownMs || cooldownMs <= 0) {
    return false;
  }
  if (sessionID && sessionID === getLastGlobalFailoverSessionID()) {
    return false;
  }
  return Date.now() - getLastGlobalFailoverAt() < cooldownMs;
}

/** queueFailover does merge pending failover payload into the session queue. */
export function queueFailover(sessionID: string, pending: Record<string, unknown>): void {
  const existing = (pendingBySession.get(sessionID) ?? {}) as Record<string, unknown>;
  pendingBySession.set(sessionID, {
    queuedAt: Date.now(),
    ...existing,
    ...pending,
  });
}

/** resolveEventSessionID does extract a session ID from heterogeneous event payloads. */
export function resolveEventSessionID(event: any): string | null {
  const props = event?.properties ?? {};
  return (
    props.sessionID
    ?? props.info?.sessionID
    ?? props.message?.sessionID
    ?? props.message?.info?.sessionID
    ?? props.part?.sessionID
    ?? props.part?.message?.sessionID
    ?? null
  );
}

/** processFailover does replay the last user message on the next fallback target. */
export async function processFailover(ctx: any, sessionID: string): Promise<void> {
  const pending = pendingBySession.get(sessionID) as Record<string, any> | undefined;
  if (!pending) {
    return;
  }
  const bounceCount = (bounceCountBySession.get(sessionID) ?? 0) + 1;
  bounceCountBySession.set(sessionID, bounceCount);
  if (bounceCount > MAX_BOUNCE_COUNT) {
    pendingBySession.delete(sessionID);
    clearStallWatchdog(sessionID);
    await logFailoverEvent('BOUNCE_LIMIT', sessionID, {
      bounces: bounceCount,
      chain: providerChainSummary(),
    });
    await ctx.client.tui
      .showToast({
        body: {
          title: 'Model Failover',
          message: `Stopped: failover bounced ${bounceCount} times between providers. All providers may be at quota.`,
          variant: 'error',
          duration: 6000,
        },
      })
      .catch(() => {});
    return;
  }
  clearStallWatchdog(sessionID);
  pendingBySession.delete(sessionID);
  const messagesResp = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  });
  const messages = messagesResp.data ?? [];
  const lastUserMessage: any = [...messages]
    .reverse()
    .find((message) => message.info?.role === 'user');
  if (!lastUserMessage) {
    return;
  }
  const failedAssistant = [...messages]
    .reverse()
    .find(
      (message) => message.info?.role === 'assistant' && message.info?.error,
    );
  const failedModel =
    pending.failedModel
    ?? (failedAssistant?.info?.providerID && failedAssistant?.info?.modelID
      ? {
          providerID: failedAssistant.info.providerID,
          modelID: failedAssistant.info.modelID,
        }
      : null);

  const userMessageID = lastUserMessage.info.id;
  const userModel = lastUserMessage.info?.model;
  const tierHint =
    pending.modelTierHint
    ?? inferTierFromModel(failedModel)
    ?? inferTierFromModel(userModel);
  if (!tierHint) {
    await ctx.client.tui
      .showToast({
        body: {
          title: 'Model Failover',
          message:
            'Skipped automatic failover: unable to infer model tier from the failed run.',
          variant: 'warning',
          duration: 5000,
        },
      })
      .catch(() => {});
    return;
  }
  const attemptedSet = getAttemptedTargets(sessionID, userMessageID);
  let target = pickFallback(failedModel, attemptedSet, tierHint);
  if (!target) {
    await ctx.client.tui
      .showToast({
        body: {
          title: 'Model Failover',
          message: 'No additional fallback model available.',
          variant: 'error',
          duration: 4500,
        },
      })
      .catch(() => {});
    return;
  }
  const retryParts = (lastUserMessage.parts ?? [])
    .map(convertPartToInput)
    .filter(Boolean);
  const safeParts =
    retryParts.length > 0 ? retryParts : [{ type: 'text', text: 'continue' }];
  const MAX_DISPATCH_ATTEMPTS = 10;
  let attempts = 0;
  while (target && attempts < MAX_DISPATCH_ATTEMPTS) {
    attempts++;
    const targetKey = modelKey(target);
    attemptedSet.add(targetKey);

    await showDebugTriggerToast(
      ctx,
      sessionID,
      'failover.dispatch',
      `${target.providerID}/${target.modelID}`,
    );
    await logFailoverEvent('DISPATCH', sessionID, {
      from: formatModel(failedModel ?? userModel),
      to: formatModel(target),
      tier: tierHint,
    });
    await ctx.client.tui
      .showToast({
        body: {
          title: 'Model Failover',
          message: buildFailoverToastMessage({
            sessionID,
            fromModel: failedModel ?? userModel,
            toModel: target,
            tierHint,
            queuedAt: pending.queuedAt,
          }),
          variant: 'warning',
          duration: 7000,
        },
      })
      .catch(() => {});
    try {
      await ctx.client.session.prompt({
        path: { id: sessionID },
        query: { directory: ctx.directory },
        body: {
          parts: safeParts,
          agent: lastUserMessage.info.agent,
          system: lastUserMessage.info.system,
          tools: lastUserMessage.info.tools,
          model: target,
        },
      });
      setLastGlobalFailoverAt(Date.now());
      setLastGlobalFailoverSessionID(sessionID);
      const dispatchLatencyMs =
        typeof pending.queuedAt === 'number'
          ? Math.max(0, Date.now() - pending.queuedAt)
          : undefined;
      if (dispatchLatencyMs !== undefined) {
        lastFailoverMsBySession.set(sessionID, dispatchLatencyMs);
      }
      lastTransitionBySession.set(sessionID, {
        from: failedModel ?? userModel ?? null,
        to: target,
        tierHint,
        at: Date.now(),
      });
      await logFailoverEvent('DISPATCH_OK', sessionID, {
        from: formatModel(failedModel ?? userModel),
        to: formatModel(target),
        tier: tierHint,
        latency:
          dispatchLatencyMs !== undefined
            ? `${dispatchLatencyMs}ms`
            : undefined,
      });
      armStallWatchdog(ctx, sessionID, target, tierHint, processFailover);
      return;
    } catch (dispatchErr) {
      const errDetail = summarizeDispatchError(dispatchErr);
      const errReason = exactDispatchErrorReason(dispatchErr);
      const errCategory = categorizeDispatchError(dispatchErr);
      const hint = dispatchErrorHint(target.providerID, errCategory);
      console.error(
        `[opencode-quota-failover] dispatch to ${formatModel(target)} failed: ${errDetail}`,
      );
      await logFailoverEvent('DISPATCH_ERROR', sessionID, {
        target: formatModel(target),
        tier: tierHint,
        error: errReason,
        category: errCategory,
      });
      await showDebugTriggerToast(
        ctx,
        sessionID,
        'failover.dispatch_error',
        `${formatModel(target)}: ${errReason}`,
      );
      await ctx.client.tui
        .showToast({
          body: {
            title: 'Failover Dispatch Error',
            message: [
              `${formatModel(target)} failed`,
              `Reason: ${errReason}`,
              `Category: ${errCategory}`,
              `Hint: ${hint}`,
            ].join('\n'),
            variant: 'error',
            duration: 9000,
          },
        })
        .catch(() => {});
      target = pickFallback(failedModel, attemptedSet, tierHint);
    }
  }
  await logFailoverEvent('EXHAUSTED', sessionID, {
    tier: tierHint,
    chain: providerChainSummary(),
    attempts,
  });
  await ctx.client.tui
    .showToast({
      body: {
        title: 'Model Failover',
        message:
          'All fallback providers failed. Check provider configuration and API keys.',
        variant: 'error',
        duration: 5000,
      },
    })
    .catch(() => {});
}

/** runManualFailover does immediately replay the latest user message on a selected fallback target. */
export async function runManualFailover(
  ctx: any,
  opts: {
    sessionID: string;
    providerID?: string;
    modelID?: string;
    tier?: KnownTier;
  },
): Promise<string> {
  const { sessionID, providerID, modelID, tier } = opts;
  const startedAt = Date.now();
  clearStallWatchdog(sessionID);
  const messagesResp = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  });
  const messages = messagesResp.data ?? [];
  const replayUserMessage: any = pickReplayUserMessage(messages);
  if (!replayUserMessage) {
    return 'Unable to run failover-now: no user message found to replay.';
  }
  const assistantWithModel = [...messages]
    .reverse()
    .find(
      (message) =>
        message.info?.role === 'assistant'
        && message.info?.providerID
        && message.info?.modelID,
    );
  const currentModel =
    replayUserMessage.info?.model
    ?? (assistantWithModel
      ? {
          providerID: assistantWithModel.info.providerID,
          modelID: assistantWithModel.info.modelID,
        }
      : null);
  const tierHint =
    tier
    ?? inferTierFromModel(
      providerID && modelID ? { providerID, modelID } : null,
    )
    ?? inferTierFromModel(currentModel);
  const attemptedSet = getAttemptedTargets(
    sessionID,
    replayUserMessage.info.id,
  );
  let target;
  if (providerID && modelID) {
    const canonical = canonicalModelID(providerID, modelID);
    if (!canonical) {
      return [
        `Unknown model for provider ${providerID}: ${modelID}`,
        'Available models:',
        ...availableModelsForProvider(providerID).map((id) => `- ${id}`),
      ].join('\n');
    }
    target = { providerID, modelID: canonical };
  } else if (providerID) {
    if (!tierHint) {
      return 'Unable to infer tier for provider-targeted failover. Provide `tier` explicitly.';
    }
    const mapped = getModelForProviderTier(providerID, tierHint);
    if (!mapped) {
      return `No configured model mapping for provider ${providerID} at tier ${tierHint}.`;
    }
    target = { providerID, modelID: mapped };
  } else {
    if (!tierHint) {
      return 'Unable to infer tier from current model. Provide `tier` or explicit provider/model.';
    }
    target = pickFallback(currentModel, attemptedSet, tierHint);
  }
  if (!target) {
    return 'No additional fallback model available for failover-now.';
  }
  if (currentModel && modelKey(target) === modelKey(currentModel)) {
    return `Already on target model ${formatModel(target)}.`;
  }
  const retryParts = (replayUserMessage.parts ?? [])
    .map(convertPartToInput)
    .filter(Boolean);
  const safeParts =
    retryParts.length > 0
      ? retryParts
      : [{ type: 'text', text: 'Continue from the latest unfinished task.' }];
  const targetKey = modelKey(target);
  attemptedSet.add(targetKey);
  recordTrigger(
    sessionID,
    'manual.failover_now',
    `${formatModel(currentModel)} -> ${formatModel(target)}`,
  );
  await logFailoverEvent('MANUAL', sessionID, {
    from: formatModel(currentModel),
    to: formatModel(target),
    tier: tierHint,
  });
  try {
    await ctx.client.session.prompt({
      path: { id: sessionID },
      query: { directory: ctx.directory },
      body: {
        parts: safeParts,
        agent: replayUserMessage.info.agent,
        system: replayUserMessage.info.system,
        tools: replayUserMessage.info.tools,
        model: target,
      },
    });
  } catch (dispatchErr) {
    const errDetail = summarizeDispatchError(dispatchErr);
    const errReason = exactDispatchErrorReason(dispatchErr);
    const errCategory = categorizeDispatchError(dispatchErr);
    const hint = dispatchErrorHint(target.providerID, errCategory);
    console.error(
      `[opencode-quota-failover] manual dispatch to ${formatModel(target)} failed: ${errDetail}`,
    );
    await logFailoverEvent('DISPATCH_ERROR', sessionID, {
      source: 'manual',
      target: formatModel(target),
      tier: tierHint,
      error: errReason,
      category: errCategory,
    });
    attemptedSet.delete(targetKey);
    return [
      `Failed to dispatch failover to ${formatModel(target)}.`,
      `Reason: ${errReason}`,
      `Category: ${errCategory}`,
      `Hint: ${hint}`,
      '',
      'Check provider auth in OpenCode and ensure the selected model is available.',
    ].join('\n');
  }
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  lastFailoverMsBySession.set(sessionID, elapsedMs);
  lastTransitionBySession.set(sessionID, {
    from: currentModel ?? null,
    to: target,
    tierHint,
    at: Date.now(),
  });
  armStallWatchdog(ctx, sessionID, target, tierHint ?? null, processFailover);
  await logFailoverEvent('DISPATCH_OK', sessionID, {
    source: 'manual',
    from: formatModel(currentModel),
    to: formatModel(target),
    tier: tierHint,
    latency: `${elapsedMs}ms`,
  });
  return [
    'Failover-now dispatched.',
    `From: ${formatModel(currentModel)}`,
    `To:   ${formatModel(target)}`,
    `Tier: ${tierHint}`,
    `Replay source: ${replayUserMessage.info.id}`,
    `Latency: ${elapsedMs}ms`,
  ].join('\n');
}

/** forceFailoverFromRetryStatus does abort built-in retry and execute immediate failover. */
export async function forceFailoverFromRetryStatus(ctx: any, sessionID: string): Promise<void> {
  await showDebugTriggerToast(
    ctx,
    sessionID,
    'session.status(retry)',
    'aborting built-in retry',
  );
  await ctx.client.session
    .abort({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    })
    .catch(() => {});
  await processFailover(ctx, sessionID);
}
