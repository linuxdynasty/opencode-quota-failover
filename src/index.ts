import {
  isUsageLimitError,
  isDefinitiveQuotaError,
  isAmbiguousRateLimitSignal,
  isProviderRequestError,
  isCustomFailoverPattern,
  matchesWildcardPattern,
  normalizeCustomPattern,
  shouldTriggerFailover,
} from './detection.js';
import {
  createChatMessageHandler,
  createEventHandler,
  createSystemTransformHandler,
} from './handlers.js';
import { loadRuntimeSettings, settingsPathForRuntime } from './settings.js';
import { failoverEventLog, resetRuntimeSettings } from './state.js';
import { createTools } from './tools.js';

export { isUsageLimitError, isDefinitiveQuotaError, isAmbiguousRateLimitSignal, isProviderRequestError, isCustomFailoverPattern, matchesWildcardPattern, normalizeCustomPattern, shouldTriggerFailover };
export { failoverEventLog };

/** quotaFailoverPlugin does initialize runtime settings and bind plugin handlers. */
export default async function quotaFailoverPlugin(ctx: any) {
  resetRuntimeSettings();
  const settingsPath = settingsPathForRuntime();
  await loadRuntimeSettings(settingsPath);

  return {
    tool: createTools(ctx, settingsPath),
    'chat.message': createChatMessageHandler(ctx),
    'experimental.chat.system.transform': createSystemTransformHandler(ctx),
    event: createEventHandler(ctx),
  };
}
