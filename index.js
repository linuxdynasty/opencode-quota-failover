// Bridge file — re-exports from TypeScript entrypoint.
// Bun resolves .ts imports natively.
export { default } from './src/index.js';
export {
  isUsageLimitError,
  isDefinitiveQuotaError,
  isAmbiguousRateLimitSignal,
  isProviderRequestError,
  isCustomFailoverPattern,
  matchesWildcardPattern,
  matchWildcardPattern,
  normalizeCustomPattern,
  validateCustomPattern,
  shouldTriggerFailover,
  failoverEventLog,
} from './src/index.js';
