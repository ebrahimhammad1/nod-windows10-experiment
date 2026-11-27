/**
 * Bounded retry policy applied to every turn (see pi/index.ts). One retry on
 * transient provider failures (e.g. 429 rate limits) whether or not backup
 * models are configured, with a jittered base delay so reconnecting clients
 * do not retry in lockstep, and a 30s cap on any computed delay.
 *
 * Measured against Groq's free-tier per-minute input-token window (7,000
 * ITPM, November 2026): its 429s carry "Please try again in N s" with N
 * typically 8-10s, and the pi session retry computes baseDelayMs *
 * 2^(attempt-1) WITHOUT parsing that hint (pi-coding-agent agent-session
 * calls retryDelayMs without the error message). A base delay under the hint
 * guarantees the single retry lands inside the same window and fails, which
 * is what the live bench showed. The base therefore sits above the observed
 * hint range; other providers' transient 5xx/overload retries simply wait a
 * few seconds longer. maxRetries stays 1: the fallback chain, not repeated
 * same-model retries, is the escalation path.
 */
export const RETRY_BASE_DELAY_MS = 9000;
export const RETRY_JITTER_MS = 2000;
export const RETRY_MAX_DELAY_MS = 30_000;

export function turnRetryPolicy(random: () => number = Math.random) {
  return {
    baseDelayMs: RETRY_BASE_DELAY_MS + Math.floor(random() * RETRY_JITTER_MS),
    maxRetries: 1,
    maxAgentDelayMs: RETRY_MAX_DELAY_MS,
  };
}
