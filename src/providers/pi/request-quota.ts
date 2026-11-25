// Learned per-connection request-size quotas and a conservative request-size
// estimate, used to refuse a request locally when the provider has already
// told us it cannot fit. A quota is only ever learned from a real provider
// rejection for that connection; it is never assumed from the model's
// context window and never hardcoded.

import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { contentText, type Context } from '@earendil-works/pi-ai';
import { oversizedRequestLimit } from '../../shared/oversized-request.ts';

export type RequestQuota = { limit: number; requested: number; at: number };

const learned = new Map<string, RequestQuota>();

export function learnRequestQuota(key: string, text: string | undefined): RequestQuota | undefined {
  if (!text) return undefined;
  const parsed = oversizedRequestLimit(text);
  if (!parsed) return undefined;
  const prior = learned.get(key);
  // Keep the smallest limit seen: limits only get stricter across plans, and a
  // stale larger limit would silently re-admit oversized requests.
  if (prior && prior.limit <= parsed.limit) return prior;
  const quota = { limit: parsed.limit, requested: parsed.requested, at: Date.now() };
  learned.set(key, quota);
  return quota;
}

export function knownRequestQuota(key: string): RequestQuota | undefined {
  return learned.get(key);
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

export function quotaPreflightError(key: string, context: Context): Error | undefined {
  const quota = knownRequestQuota(key);
  if (!quota) return undefined;
  const estimate = estimateRequestTokens(context);
  if (estimate <= quota.limit) return undefined;
  return new Error(
    `Nod did not send this request: it is about ${estimate.toLocaleString('en-US')} tokens and this connection reported a limit of ${quota.limit.toLocaleString('en-US')} input tokens per minute. Choose a model or connection with a higher limit, or shorten the conversation.`,
  );
}
