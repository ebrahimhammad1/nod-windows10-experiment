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
 * The one effort value that is a MODE, not a level. Stored selections may
 * carry 'auto'; providers only ever receive the concrete level this helper
 * resolves to. Policy (no extra LLM classification calls by default):
 *   - a model with a single effort level resolves to it;
 *   - a zero-priced or unpriced/'variable' model resolves to the provider
 *     default (full capability - no cost or quota reason to degrade);
 *   - a priced model resolves to the lightest level (cost guard).
 * The level always comes from the model's OWN effort list - a level the
 * provider does not support is never invented.
 * Known limit: per-task complexity is not visible at selection-resolution
 * time, so this v1 does not adapt within a connection by request size; the
 * payload-estimate layer is the future seam for that signal.
 */
export function resolveSelectionEffort(
  provider: ModelProvider,
  model: ModelChoice,
  effort: ModelEffort | 'auto',
): ModelEffort {
  if (effort !== 'auto') return effort;
  if (!model.efforts.length) throw new Error(`Model ${model.id} supports no effort levels.`);
  if (model.efforts.length === 1) return model.efforts[0]!;
  const pricing = model.pricing;
  const free = pricing && pricing !== 'variable' && pricing.input + pricing.output === 0;
  return free || !pricing || pricing === 'variable'
    ? defaultEffort(provider, model)
    : lightestEffort(model.efforts);
}
