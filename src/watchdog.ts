import {
  clearStallWatchdog,
  pendingBySession,
  runtimeSettings,
  stallWatchdogBySession,
} from './state.js';
import { formatModel, modelKey } from './models.js';
import { showDebugTriggerToast } from './reporting.js';

/** handleStallWatchdogTimeout does process a watchdog timeout and invoke failover callback. */
export async function handleStallWatchdogTimeout(
  ctx: any,
  sessionID: string,
  target: any,
  tierHint: string | null,
  startedAt: number,
  onTimeout: (ctx: any, sessionID: string) => Promise<void>,
): Promise<void> {
  const current = stallWatchdogBySession.get(sessionID) as
    | { target?: any; startedAt?: number }
    | undefined;
  if (
    !current
    || modelKey(current.target) !== modelKey(target)
    || current.startedAt !== startedAt
  ) {
    return;
  }
  stallWatchdogBySession.delete(sessionID);

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  await showDebugTriggerToast(
    ctx,
    sessionID,
    'watchdog.stall_timeout',
    `${formatModel(target)} after ${elapsedMs}ms`,
  );

  const existing = (pendingBySession.get(sessionID) ?? {}) as Record<string, unknown>;
  pendingBySession.set(sessionID, {
    queuedAt: Date.now(),
    ...existing,
    modelTierHint: tierHint,
    failedModel: target,
  });

  await ctx.client.session
    .abort({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    })
    .catch(() => {});

  await onTimeout(ctx, sessionID);
}

/** armStallWatchdog does schedule timeout-based failover for stalled sessions. */
export function armStallWatchdog(
  ctx: any,
  sessionID: string,
  target: any,
  tierHint: string | null,
  onTimeout: (ctx: any, sessionID: string) => Promise<void>,
): void {
  if (!runtimeSettings.stallWatchdogEnabled) {
    return;
  }

  clearStallWatchdog(sessionID);

  const startedAt = Date.now();
  const timeoutMs = Math.max(
    1000,
    Number(runtimeSettings.stallWatchdogMs) || 45 * 1000,
  );
  const timer = setTimeout(
    () =>
      handleStallWatchdogTimeout(
        ctx,
        sessionID,
        target,
        tierHint,
        startedAt,
        onTimeout,
      ).catch(() => {}),
    timeoutMs,
  );
  timer.unref?.();

  stallWatchdogBySession.set(sessionID, {
    target,
    tierHint,
    startedAt,
    timeoutMs,
    timer,
  });
}
