// Learned per-connection request-size quotas and a conservative request-size
// estimate, used to refuse a request locally when the provider has already
// told us it cannot fit. A quota is only ever learned from a real provider
// rejection for that connection; it is never assumed from the model's
// context window and never hardcoded.
//
// Staleness: the learned limit is the provider's per-minute input-token cap
// at the moment it rejected us. Account tier changes move it in either
// direction, so (a) the newest provider-reported value always replaces the
// old one, up or down, (b) a learned limit expires after QUOTA_TTL_MS, and
// (c) even inside the TTL a single probe request is allowed through every
// PROBE_INTERVAL_MS: if the connection's limit rose (tier upgrade) the probe
// succeeds and normal traffic resumes within minutes instead of hours; if
// not, the provider rejects it and re-teaches the current limit. A learned
// limit can therefore never lock a connection for more than one probe
// interval, and the probe costs at most one rejected request.

import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { contentText, type Context } from '@earendil-works/pi-ai';
import { oversizedRequestLimit } from '../../shared/oversized-request.ts';

export type RequestQuota = { limit: number; requested: number; at: number };

export const QUOTA_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const PROBE_INTERVAL_MS = 5 * 60 * 1000; // one probe per 5 minutes

const learned = new Map<string, RequestQuota>();
const lastRefusal = new Map<string, number>();

export function learnRequestQuota(
  key: string,
  text: string | undefined,
  now: number = Date.now(),
): RequestQuota | undefined {
  if (!text) return undefined;
  const parsed = oversizedRequestLimit(text);
  if (!parsed) return undefined;
  // The provider's newest report is the best truth in both directions: plans
  // get stricter (limit drops) and tiers get upgraded (limit rises).
  const quota = { limit: parsed.limit, requested: parsed.requested, at: now };
  learned.set(key, quota);
  // The rejection itself is a fresh check: the probe interval starts now, so
  // an immediate retry is refused locally and the next probe is one interval out.
  lastRefusal.set(key, now);
  return quota;
}

export function knownRequestQuota(key: string, now: number = Date.now()): RequestQuota | undefined {
  const quota = learned.get(key);
  if (!quota) return undefined;
  if (now - quota.at >= QUOTA_TTL_MS) {
    learned.delete(key); // expired: let the next request through to re-learn
    return undefined;
  }
  return quota;
}

// Token estimate for one built request. Conversation messages use the
// library estimator (chars/4, deliberately conservative). The system message
// carries the prompt and the declared tool schemas (sections + toolsAdded),
// which tokenize much denser than prose, so it is calibrated at ~2.5
// characters per token against the provider's own count for a real request
// (38,765 request bytes counted as 15,463 input tokens). It stays an
// estimate: the preflight only refuses when even this approximate size
// exceeds a limit the provider itself reported.
export function estimateRequestTokens(context: Context): number {
  let total = (context.systemPrompt?.length ?? 0) / 2.5;
  for (const tool of context.tools ?? [])
    total +=
      ((tool.name?.length ?? 0) + (tool.description?.length ?? 0)) / 4 +
      JSON.stringify(tool.parameters ?? {}).length / 2.5;
  for (const message of context.messages) {
    if ((message as { role?: string }).role === 'system') {
      const system = message as unknown as {
        content?: unknown;
        sections?: Record<string, string | undefined>;
        toolsAdded?: unknown;
      };
      let chars =
        typeof system.content === 'string'
          ? system.content.length
          : contentText(system.content as never).length;
      for (const section of Object.values(system.sections ?? {})) chars += section?.length ?? 0;
      if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
      total += chars / 2.5;
    } else total += estimateTokens(message as never);
  }
  return Math.ceil(total);
}

// Per-connection estimate calibration: the raw estimate is deliberately
// conservative (~2.5 chars/token), but real tokenization varies by content
// (a prose-heavy minimal request measured 4.4 chars/token live). One real
// provider count corrects the estimate for that connection, clamped so a
// single odd observation can only halve or double it.
const calibration = new Map<string, number>();

export function noteObservedUsage(key: string, rawEstimate: number, realTokens: number): void {
  if (rawEstimate <= 0 || realTokens <= 0) return;
  const factor = Math.min(2, Math.max(0.5, rawEstimate / realTokens));
  const prior = calibration.get(key);
  // Blend so one odd request does not swing the estimate wildly.
  calibration.set(key, prior === undefined ? factor : prior * 0.5 + factor * 0.5);
}

function calibratedEstimate(key: string, context: Context): number {
  const raw = estimateRequestTokens(context);
  const factor = calibration.get(key);
  return factor === undefined ? raw : Math.ceil(raw / factor);
}

export function quotaPreflightError(
  key: string,
  context: Context,
  now: number = Date.now(),
): Error | undefined {
  const quota = knownRequestQuota(key, now);
  if (!quota) return undefined;
  const estimate = calibratedEstimate(key, context);
  if (estimate <= quota.limit) return undefined;
  // Bounded probe: one request per interval goes through to re-check the
  // limit against the provider instead of trusting the learned value.
  const refusedAt = lastRefusal.get(key);
  if (refusedAt === undefined || now - refusedAt >= PROBE_INTERVAL_MS) {
    lastRefusal.set(key, now);
    return undefined;
  }
  return new Error(
    `Nod did not send this request: it is roughly ${estimate.toLocaleString('en-US')} tokens (an estimate; the provider counts exactly) and this connection reported a limit of ${quota.limit.toLocaleString('en-US')} input tokens per minute ${Math.round((now - quota.at) / 60000)} minutes ago. Choose a model or connection with a higher limit, or shorten the conversation. The connection is re-checked automatically every few minutes and whenever its provider reports a different limit.`,
  );
}


// Per-minute pacing rejections (HTTP 429) arrive with provider-specific
// wording, and both Groq and Gemini append billing/upsell text that makes
// the pi session retry classify them as non-retryable billing limits (the
// "billing"/"quota exceeded" patterns in pi-ai's
// NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN). So the session layer never
// retries these; the single-connection wrapper is the only place they can
// be honored.
export const RATE_LIMIT_WAIT_CAP_MS = 30_000;

// The wait hint is the retry signal: a provider that says when capacity
// frees is describing per-minute pacing, and a hint beyond the cap (a daily
// quota says hours) fails clearly instead of being truncated. Groq phrases
// it "Please try again in 8.61s"; Gemini free tier phrases it "Please retry
// in 11.732249794s" plus a structured "retryDelay: 11s". Both providers
// append billing/upsell text that makes the pi session retry classify these
// as non-retryable, so this wrapper is the only place they are honored.
const RETRY_HINT_PATTERNS = [
  /try again in\s+([\d.]+)\s*s/i,
  /retry in\s+([\d.]+)\s*s/i,
  /retryDelay["']?\s*:\s*"?([\d.]+)s"?/i,
];
// A hint alone is not enough: the error must actually be a 429 pacing
// rejection, or an unrelated error that happens to contain "retry in Ns"
// would trigger a provider retry. Groq says "Rate limit reached"; Gemini
// says "HTTP 429 ... Too Many Requests ... RESOURCE_EXHAUSTED".
const RATE_LIMIT_ERROR_PATTERN = /\b429\b|too many requests|rate.?limit|resource_exhausted/i;
export function retryableRateLimitWait(text: string | undefined): number | undefined {
  if (!text || !RATE_LIMIT_ERROR_PATTERN.test(text)) return undefined;
  for (const pattern of RETRY_HINT_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const ms = seconds * 1000;
    if (ms > RATE_LIMIT_WAIT_CAP_MS) return undefined;
    return ms;
  }
  return undefined;
}

// Output-token pacing is a separate learned limit (Groq free tier: OTPM
// 1,000 vs ITPM 7,000). A request whose max_tokens alone exceeds the
// connection's output limit is always rejected ("The request's expected
// output tokens exceed the enforced limit"), so once the provider reports
// the limit, max_tokens is clamped to it instead of wasting the request.
const learnedOutput = new Map<string, { limit: number; at: number }>();

export function learnOutputQuota(
  key: string,
  text: string | undefined,
  now: number = Date.now(),
): { limit: number; at: number } | undefined {
  if (!text) return undefined;
  const match = text.match(/output tokens per minute \(OTPM\): Limit ([\d,]+)/i);
  if (!match) return undefined;
  const limit = Number(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  const quota = { limit, at: now };
  learnedOutput.set(key, quota);
  return quota;
}

export function knownOutputQuota(
  key: string,
  now: number = Date.now(),
): { limit: number; at: number } | undefined {
  const quota = learnedOutput.get(key);
  if (!quota) return undefined;
  if (now - quota.at >= QUOTA_TTL_MS) {
    learnedOutput.delete(key);
    return undefined;
  }
  return quota;
}

// Remaining output budget inside the current minute, per connection. The
// learned OTPM limit is a per-minute window, not a per-request allowance:
// clamping every request to the full limit would still reject whenever a
// turn makes two requests in one minute. Track observed output usage and
// clamp to what is left, with a small floor so a turn is never strangled
// to zero (the provider still answers small requests as the window slides).
const outputUsed = new Map<string, { minute: number; used: number }>();
// Below this many remaining output tokens a request is not worth sending:
// asking for more than the window has left is a guaranteed rejection, and
// silently shrinking the answer destroys the task. Wait for the window
// instead (outputBudgetWaitMs).
export const OUTPUT_MIN_USEFUL_TOKENS = 64;

export function noteObservedOutput(key: string, outputTokens: number, now: number = Date.now()) {
  if (outputTokens <= 0) return;
  const minute = Math.floor(now / 60_000);
  const entry = outputUsed.get(key);
  if (!entry || entry.minute !== minute) outputUsed.set(key, { minute, used: outputTokens });
  else entry.used += outputTokens;
}

export function remainingOutputBudget(key: string, now: number = Date.now()): number | undefined {
  const quota = knownOutputQuota(key, now);
  if (!quota) return undefined;
  const minute = Math.floor(now / 60_000);
  const entry = outputUsed.get(key);
  const used = entry && entry.minute === minute ? entry.used : 0;
  return Math.max(0, quota.limit - used);
}

// Milliseconds until the output window has room again, when the remaining
// budget is too small to be useful. The provider's window is sliding, so
// the next minute boundary is an approximation; the 429 hint-retry remains
// the backstop when it fires anyway.
export function outputBudgetWaitMs(key: string, now: number = Date.now()): number {
  const remaining = remainingOutputBudget(key, now);
  if (remaining === undefined || remaining >= OUTPUT_MIN_USEFUL_TOKENS) return 0;
  return 60_000 - (now % 60_000) + 250;
}
