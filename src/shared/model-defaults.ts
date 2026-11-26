import { lightestEffort } from './models.ts';
import type { ModelChoice, ModelEffort, ModelMethod, ModelProvider } from './models.ts';

export const agentModels: Partial<Record<ModelProvider, string>> = {
  'ant-ling': 'Ling-3.1-flash',
  anthropic: 'claude-opus-5-5',
  azure: 'gpt-6.1-sol',
  baseten: 'moonshotai/Kimi-K3',
  cerebras: 'qwen-3.8-27b',
  'cloudflare-ai-gateway': 'gpt-6.1-sol',
  'cloudflare-workers-ai': '@cf/moonshotai/kimi-k2.7-code',
  deepseek: 'deepseek-flash',
  fireworks: 'accounts/fireworks/models/kimi-k3',
  google: 'gemini-4-argon',
  'google-vertex': 'gemini-4-argon',
  groq: 'qwen/qwen3.8-27b',
  huggingface: 'moonshotai/Kimi-K3',
  'kimi-coding': 'k3',
  meta: 'muse-spark-1.3',
  minimax: 'MiniMax-M3',
  'minimax-cn': 'MiniMax-M3',
  mistral: 'mistral-large-4',
  moonshotai: 'kimi-k3',
  'moonshotai-cn': 'kimi-k3',
  nvidia: 'z-ai/glm-5.3-flash',
  openai: 'gpt-6.1-sol',
  opencode: 'gpt-6.1-sol',
  'opencode-go': 'kimi-k3',
  openrouter: 'openai/gpt-6.1-sol',
  hostinger: 'default-hostinger',
  'qwen-token-plan': 'qwen3.8-max',
  'qwen-token-plan-cn': 'qwen3.8-max',
  'qwen-token-plan-individual': 'qwen3.8-max',
  radius: 'balanced',
  together: 'moonshotai/Kimi-K3',
  'vercel-ai-gateway': 'openai/gpt-6.1-sol',
  xai: 'grok-4.7',
  xiaomi: 'mimo-v2.6-pro',
  'xiaomi-token-plan-ams': 'mimo-v2.6-pro',
  'xiaomi-token-plan-cn': 'mimo-v2.6-pro',
  'xiaomi-token-plan-sgp': 'mimo-v2.6-pro',
  zai: 'glm-5.3-flash',
  'zai-coding-cn': 'glm-5.3-flash',
};

export const memoryModels: Partial<Record<ModelProvider, string>> = {
  openai: 'gpt-6-luna',
  anthropic: 'claude-haiku-5-5',
  openrouter: 'openai/gpt-6-luna',
  hostinger: 'gpt-6-luna',
  google: 'gemini-3.8-flash',
  'google-vertex': 'gemini-3.8-flash',
  mistral: 'mistral-small-latest',
  opencode: 'gpt-6-luna',
  'vercel-ai-gateway': 'openai/gpt-6-luna',
  radius: 'cheap',
};

export function defaultModel(provider: ModelProvider, models: ModelChoice[], method?: ModelMethod) {
  if (provider === 'amazon-bedrock' && models.length > 1) return undefined;
  const preferred =
    (provider === 'openai' && models.find((model) => model.id === 'gpt-6.2-sol')) ||
    (method === 'subscription' && models.find((model) => model.id === 'gpt-6-sol')) ||
    models.find((model) => model.id === agentModels[provider]);
  if (preferred || provider === 'google') return preferred;
  return models[0];
}

export function defaultEffort(provider: ModelProvider, model: ModelChoice): ModelEffort {
  const preferred =
    provider === 'google' || provider === 'google-vertex' || provider === 'ant-ling'
      ? 'medium'
      : 'high';
  return model.efforts.includes(preferred) ? preferred : model.efforts[0];
}

/**
 * Signals the request-time layer can see when resolving Auto: the estimated
 * size of THIS turn's payload, STRUCTURAL complexity markers of the prompt
 * (task complexity, no LLM classification call) and the connection's
 * learned per-minute quotas (headroom).
 */
export interface EffortSignal {
  estimatedInputTokens?: number;
  structuralComplexity?: boolean;
  inputQuotaPerMinute?: number;
  outputQuotaPerMinute?: number;
}

/**
 * Language-neutral STRUCTURAL task-complexity markers in the prompt text
 * (no keywords, no model call): a code fence, a multi-item list, several
 * questions (Latin and Arabic marks), or a multi-paragraph request. Size
 * alone says nothing about difficulty - a one-line regex puzzle is harder
 * than a long pasted log - so these markers keep a small-but-complex
 * prompt from being classed as a simple turn.
 */
export function promptStructuralComplexity(text: string): boolean {
  if (text.includes('```')) return true;
  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length >= 4) return true;
  const listItems = lines.filter((line) => /^\s*(?:[-*•]|\d+[.)])\s/.test(line)).length;
  if (listItems >= 3) return true;
  const questions = (text.match(/[?؟]/g) ?? []).length;
  return questions >= 2;
}

// A turn at or below this estimate is simple (a greeting, a short question)
// and needs no reasoning depth.
export const AUTO_SIMPLE_TASK_TOKENS = 2048;
// At or above this estimate the task is substantial enough to justify the
// provider default level even on a priced connection.
export const AUTO_SUBSTANTIAL_TASK_TOKENS = 8192;
// Tight-quota guards, from measured free-tier limits (Groq: 7,000 input /
// 1,000 output tokens per minute): reasoning effort spends the same scarce
// per-minute output window the reply itself needs, so tight connections
// stay light.
export const AUTO_TIGHT_INPUT_QUOTA = 8000;
export const AUTO_TIGHT_OUTPUT_QUOTA = 1000;

/**
 * 'auto' is a selection MODE, not a level. Stored selections may carry it;
 * providers only ever receive the concrete level this resolves to. Policy
 * (no extra LLM classification calls by default, in order):
 *   1. a model with a single effort level resolves to it;
 *   2. a tight learned quota keeps the lightest level (reasoning would burn
 *      the scarce per-minute output window - measured on the free tier);
 *   3. a simple turn (small estimated payload AND no structural
 *      complexity markers in the prompt) keeps the lightest level;
 *   4. a priced model keeps the lightest level unless the task is
 *      substantial (cost guard);
 *   5. otherwise the provider default.
 * Auto never EXCEEDS the provider default and the level always comes from
 * the model's OWN effort list - nothing provider-unsupported is invented.
 * Called once per request at the payload layer, where the turn's content
 * and the learned quotas are both visible.
 */
export function resolveSelectionEffort(
  provider: ModelProvider,
  model: ModelChoice,
  effort: ModelEffort | 'auto',
  signal: EffortSignal = {},
): ModelEffort {
  if (effort !== 'auto') return effort;
  if (!model.efforts.length) throw new Error(`Model ${model.id} supports no effort levels.`);
  if (model.efforts.length === 1) return model.efforts[0]!;
  const lightest = lightestEffort(model.efforts);
  const tightInput =
    signal.inputQuotaPerMinute !== undefined &&
    signal.inputQuotaPerMinute <= AUTO_TIGHT_INPUT_QUOTA;
  const tightOutput =
    signal.outputQuotaPerMinute !== undefined &&
    signal.outputQuotaPerMinute <= AUTO_TIGHT_OUTPUT_QUOTA;
  if (tightInput || tightOutput) return lightest;
  if (
    signal.estimatedInputTokens !== undefined &&
    signal.estimatedInputTokens <= AUTO_SIMPLE_TASK_TOKENS &&
    !signal.structuralComplexity
  )
    return lightest;
  const pricing = model.pricing;
  const priced = pricing && pricing !== 'variable' && pricing.input + pricing.output > 0;
  if (
    priced &&
    (signal.estimatedInputTokens === undefined ||
      signal.estimatedInputTokens < AUTO_SUBSTANTIAL_TASK_TOKENS)
  )
    return lightest;
  return defaultEffort(provider, model);
}
