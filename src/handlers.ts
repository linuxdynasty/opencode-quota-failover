import { SYSTEM_PROMPT_PREFIX } from './constants.js';
import {
  isBedrockOpusModel,
  isThinkingBlockMutationError,
  parseRetryBackoffMs,
  shouldTriggerFailover,
} from './detection.js';
import {
  forceFailoverFromRetryStatus,
  isWithinGlobalCooldown,
  processFailover,
  queueFailover,
  resolveEventSessionID,
} from './failover.js';
import {
  buildFallbackChain,
  clearDispatchFailures,
  formatModel,
  inferTierFromModel,
  recordDispatchFailure,
} from './models.js';
import {
  buildSystemPromptInfo,
  formatMs,
  safeNumber,
  showDebugTriggerToast,
  summarizeDispatchError,
  summarizeText,
} from './reporting.js';
import { logFailoverEvent } from './settings.js';
import {
  bounceCountBySession,
  clearStallWatchdog,
  cleanupSession,
  infoShownBySession,
  lastAssistantStatsBySession,
  lastFailoverMsBySession,
  lastRetryStatusBySession,
  pendingBySession,
  runtimeSettings,
} from './state.js';

/** createChatMessageHandler does build the first-user-message info toast handler. */
export function createChatMessageHandler(ctx: any) {
  return async (input: any, _output: any): Promise<void> => {
    const sessionID = input.sessionID;
    if (!sessionID || infoShownBySession.has(sessionID)) {
      return;
    }

    const currentModel = input.model ?? null;
    const tierHint = inferTierFromModel(currentModel);
    const fallbackChain = buildFallbackChain(tierHint);
    const lastFailoverMs = lastFailoverMsBySession.get(sessionID);
    const line = buildSystemPromptInfo(
      currentModel,
      fallbackChain,
      lastFailoverMs,
    ).replace(`${SYSTEM_PROMPT_PREFIX} `, '');

    await ctx.client.tui
      .showToast({
        body: {
          title: 'Failover Active',
          message: line,
          variant: 'info',
          duration: 6500,
        },
      })
      .catch(() => {});

    infoShownBySession.add(sessionID);
  };
}

/** createSystemTransformHandler does inject dynamic failover status into system prompt lines. */
export function createSystemTransformHandler(_ctx: any) {
  return async (input: any, output: any): Promise<void> => {
    const currentModel = {
      providerID: input.model?.providerID,
      modelID: input.model?.id,
    };
    const tierHint = inferTierFromModel(currentModel);
    const fallbackChain = buildFallbackChain(tierHint);
    const lastFailoverMs = input.sessionID
      ? lastFailoverMsBySession.get(input.sessionID)
      : undefined;
    const line = buildSystemPromptInfo(
      currentModel,
      fallbackChain,
      lastFailoverMs,
    );

    output.system = (output.system ?? []).filter(
      (entry: string) => !entry.startsWith(SYSTEM_PROMPT_PREFIX),
    );
    output.system.push(line);
  };
}

/** createEventHandler does build the event-stream failover detector and dispatcher handler. */
export function createEventHandler(ctx: any) {
  return async ({ event }: { event: any }): Promise<void> => {
    try {
      if (event.type === 'session.deleted') {
        cleanupSession(event.properties?.info?.id);
        return;
      }

      if (event.type === 'message.updated') {
        const info = event.properties?.info;
        if (!info || info.role !== 'assistant' || !info.sessionID) {
          return;
        }

        lastAssistantStatsBySession.set(info.sessionID, {
          providerID: info.providerID,
          modelID: info.modelID,
          inputTokens: safeNumber(info.tokens?.input),
          outputTokens: safeNumber(info.tokens?.output),
          reasoningTokens: safeNumber(info.tokens?.reasoning),
          at: Date.now(),
        });

        const outputTokens = safeNumber(info.tokens?.output) ?? 0;

        if (info.error || outputTokens > 0) {
          clearStallWatchdog(info.sessionID);
        }

        if (!info.error && outputTokens > 0) {
          bounceCountBySession.delete(info.sessionID);
          clearDispatchFailures(info.providerID);
        }

        const failedModel = {
          providerID: info.providerID,
          modelID: info.modelID,
        };
        if (
          !info.error
          || !shouldTriggerFailover(info.error, failedModel, {
            requireDefinitive: true,
            customPatterns: runtimeSettings.customFailoverPatterns,
          })
        ) {
          return;
        }

        if (isWithinGlobalCooldown(info.sessionID)) {
          return;
        }
        recordDispatchFailure(info.providerID, 'quota');
        const forceOpusTier =
          isBedrockOpusModel(failedModel)
          && isThinkingBlockMutationError(info.error);
        queueFailover(info.sessionID, {
          modelTierHint: forceOpusTier
            ? 'opus'
            : inferTierFromModel(failedModel),
          failedModel,
        });
        await logFailoverEvent('TRIGGER', info.sessionID, {
          source: 'message.updated',
          from: formatModel(failedModel),
          reason: summarizeDispatchError(info.error),
          tier: forceOpusTier ? 'opus' : inferTierFromModel(failedModel),
        });
        await showDebugTriggerToast(
          ctx,
          info.sessionID,
          'message.updated',
          `${info.providerID}/${info.modelID}: ${summarizeDispatchError(info.error)}`,
        );
        return;
      }

      if (event.type === 'message.part.delta') {
        const sessionID = resolveEventSessionID(event);
        if (!sessionID) {
          return;
        }
        clearStallWatchdog(sessionID);
        return;
      }

      if (event.type === 'session.status') {
        const sessionID = event.properties?.sessionID;
        const status = event.properties?.status;
        if (!sessionID || !status || status.type !== 'retry') {
          return;
        }

        lastRetryStatusBySession.set(sessionID, {
          attempt: status.attempt,
          nextAt: status.next,
          message: status.message,
          retryBackoffMs: parseRetryBackoffMs(status.message),
        });

        const retryMessage = status.message;
        const lastAssistant = lastAssistantStatsBySession.get(sessionID) as
          | { providerID?: string; modelID?: string }
          | undefined;
        const failedModel =
          lastAssistant?.providerID && lastAssistant?.modelID
            ? {
                providerID: lastAssistant.providerID,
                modelID: lastAssistant.modelID,
              }
            : null;
        if (!shouldTriggerFailover(retryMessage, failedModel, {
          customPatterns: runtimeSettings.customFailoverPatterns,
        })) {
          return;
        }

        const retryBackoffMs = parseRetryBackoffMs(retryMessage);
        if (retryBackoffMs < runtimeSettings.minRetryBackoffMs) {
          return;
        }

        if (isWithinGlobalCooldown(sessionID)) {
          return;
        }

        if (failedModel?.providerID) {
          recordDispatchFailure(failedModel.providerID, 'quota');
        }
        const forceOpusTier =
          isBedrockOpusModel(failedModel)
          && isThinkingBlockMutationError(retryMessage);
        queueFailover(
          sessionID,
          forceOpusTier
            ? { modelTierHint: 'opus', failedModel }
            : failedModel
              ? { failedModel }
              : {},
        );
        await logFailoverEvent('TRIGGER', sessionID, {
          source: 'session.status(retry)',
          from: failedModel ? formatModel(failedModel) : 'unknown',
          reason: summarizeText(retryMessage, 140),
          backoff: formatMs(retryBackoffMs),
          attempt: status.attempt,
        });
        await forceFailoverFromRetryStatus(ctx, sessionID);
        return;
      }

      if (event.type === 'session.error') {
        const sessionID = event.properties?.sessionID;
        const error = event.properties?.error;
        const lastAssistant = sessionID
          ? (lastAssistantStatsBySession.get(sessionID) as
            | { providerID?: string; modelID?: string }
            | undefined)
          : null;
        const failedModel =
          lastAssistant?.providerID && lastAssistant?.modelID
            ? {
                providerID: lastAssistant.providerID,
                modelID: lastAssistant.modelID,
              }
            : null;
        if (
          !sessionID
          || !error
          || !shouldTriggerFailover(error, failedModel, {
            requireDefinitive: true,
            customPatterns: runtimeSettings.customFailoverPatterns,
          })
        ) {
          return;
        }

        if (isWithinGlobalCooldown(sessionID)) {
          return;
        }
        if (failedModel?.providerID) {
          recordDispatchFailure(failedModel.providerID, 'quota');
        }
        const forceOpusTier =
          isBedrockOpusModel(failedModel)
          && isThinkingBlockMutationError(error);
        queueFailover(
          sessionID,
          forceOpusTier
            ? { modelTierHint: 'opus', failedModel }
            : failedModel
              ? { failedModel }
              : {},
        );
        await logFailoverEvent('TRIGGER', sessionID, {
          source: 'session.error',
          from: failedModel ? formatModel(failedModel) : 'unknown',
          reason: forceOpusTier
            ? 'thinking_block_mutation'
            : summarizeDispatchError(error),
        });
        await showDebugTriggerToast(
          ctx,
          sessionID,
          'session.error',
          forceOpusTier
            ? 'bedrock opus thinking/redacted_thinking immutable-block error detected'
            : `usage/rate limit: ${summarizeDispatchError(error)}`,
        );
        return;
      }

      if (event.type === 'session.idle') {
        const sessionID = event.properties?.sessionID;
        if (sessionID) {
          clearStallWatchdog(sessionID);
        }
        if (!sessionID || !pendingBySession.has(sessionID)) {
          return;
        }
        await processFailover(ctx, sessionID);
      }
    } catch (error) {
      console.error('[opencode-quota-failover] failed:', error);
    }
  };
}
