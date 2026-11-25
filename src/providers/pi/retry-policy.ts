/**
 * Bounded retry policy applied to every turn (see pi/index.ts). One retry on
 * transient provider failures (e.g. 429 rate limits) whether or not backup
 * models are configured, with a jittered base delay (4-6s) so reconnecting
 * clients do not retry in lockstep, and a 30s cap on any computed delay.
 * The underlying helper computes baseDelayMs * 2^(attempt-1) and ignores
 * provider retry-after hints; with maxRetries 1 the only delay is the base.
 */
export const RETRY_BASE_DELAY_MS = 4000;
export const RETRY_JITTER_MS = 2000;
export const RETRY_MAX_DELAY_MS = 30_000;

export function turnRetryPolicy(random: () => number = Math.random) {
  return {
    baseDelayMs: RETRY_BASE_DELAY_MS + Math.floor(random() * RETRY_JITTER_MS),
    maxRetries: 1,
    maxAgentDelayMs: RETRY_MAX_DELAY_MS,
  };
}
