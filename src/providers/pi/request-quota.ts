// Learned per-connection request-size quotas and a conservative request-size
// estimate, used to refuse a request locally when the provider has already
// told us it cannot fit. A quota is only ever learned from a real provider
// rejection for that connection; it is never assumed from the model's
// context window and never hardcoded.
//
// Staleness: the learned limit is the provider's per-minute input-token cap
// at the moment it rejected us. Account tier changes move it in either
// direction, so (a) the newest provider-reported value always replaces the
// old one, up or down, and (b) a learned limit expires after QUOTA_TTL_MS;
// the next request then goes to the provider again, which either succeeds or
// re-teaches the current limit. A stale limit can therefore never lock a
// connection permanently: worst case one real request per TTL window fails.

import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { contentText, type Context } from '@earendil-works/pi-ai';
import { oversizedRequestLimit } from '../../shared/oversized-request.ts';

export type RequestQuota = { limit: number; requested: number; at: number };

export const QUOTA_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const learned = new Map<string, RequestQuota>();

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

export function quotaPreflightError(
  key: string,
  context: Context,
  now: number = Date.now(),
): Error | undefined {
  const quota = knownRequestQuota(key, now);
  if (!quota) return undefined;
  const estimate = estimateRequestTokens(context);
  if (estimate <= quota.limit) return undefined;
  return new Error(
    `Nod did not send this request: it is roughly ${estimate.toLocaleString('en-US')} tokens (an estimate; the provider counts exactly) and this connection reported a limit of ${quota.limit.toLocaleString('en-US')} input tokens per minute ${Math.round((now - quota.at) / 60000)} minutes ago. Choose a model or connection with a higher limit, or shorten the conversation. If the connection's plan changed, the limit is re-checked automatically within a few hours.`,
  );
}
