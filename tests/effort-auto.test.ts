/**
 * Policy tests for resolveSelectionEffort (Auto effort mode), v2:
 * request-time signals (estimated payload size, learned quotas) + model
 * capability + cost guard. Rules, in order:
 *   1. concrete levels pass through untouched (manual picks never move);
 *   2. a single-level model resolves to its only level (the owner's qwen
 *      connection exposes only 'off');
 *   3. a tight learned quota keeps the lightest level (measured free tier:
 *      7,000 input / 1,000 output tokens per minute - reasoning would burn
 *      the scarce output window);
 *   4. a simple turn (estimate <= 2,048) keeps the lightest level;
 *   5. a priced model keeps the lightest level unless the task is
 *      substantial (>= 8,192) - cost guard;
 *   6. otherwise the provider default - Auto NEVER exceeds it;
 *   7. the level always comes from the model's own effort list - nothing
 *      provider-unsupported is invented; no levels at all rejects.
 * No network: pure function against the REAL module.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTO_SIMPLE_TASK_TOKENS,
  AUTO_SUBSTANTIAL_TASK_TOKENS,
  AUTO_TIGHT_INPUT_QUOTA,
  AUTO_TIGHT_OUTPUT_QUOTA,
  resolveSelectionEffort,
} from '../src/shared/model-defaults.ts';
import type { ModelChoice } from '../src/shared/models.ts';

const choice = (over: Partial<ModelChoice>): ModelChoice => ({
  id: 'fixture-model',
  name: 'Fixture',
  efforts: ['low', 'high'],
  images: false,
  contextWindow: 64_000,
  ...over,
});
const free = { input: 0, output: 0 };
const priced = { input: 1, output: 2 };

test('concrete levels pass through untouched', () => {
  assert.equal(resolveSelectionEffort('groq', choice({}), 'low'), 'low');
  assert.equal(resolveSelectionEffort('groq', choice({}), 'high'), 'high');
  assert.equal(
    resolveSelectionEffort('groq', choice({}), 'high', { inputQuotaPerMinute: 100 }),
    'high',
  );
});

test('single-level model resolves to its only level', () => {
  assert.equal(resolveSelectionEffort('groq', choice({ efforts: ['off'] }), 'auto'), 'off');
});

test('tight learned quota keeps the lightest level, even on a free model', () => {
  const model = choice({ pricing: free });
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', { inputQuotaPerMinute: AUTO_TIGHT_INPUT_QUOTA }),
    'low',
  );
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', { outputQuotaPerMinute: AUTO_TIGHT_OUTPUT_QUOTA }),
    'low',
  );
  // Just above the guard the quota no longer binds.
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', {
      inputQuotaPerMinute: AUTO_TIGHT_INPUT_QUOTA + 1,
    }),
    'high',
  );
});

test('a simple turn keeps the lightest level, even on a free model', () => {
  const model = choice({ pricing: free });
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', {
      estimatedInputTokens: AUTO_SIMPLE_TASK_TOKENS,
    }),
    'low',
  );
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', {
      estimatedInputTokens: AUTO_SIMPLE_TASK_TOKENS + 1,
    }),
    'high',
  );
});

test('free/unpriced substantial or unknown work resolves to the provider default', () => {
  assert.equal(resolveSelectionEffort('groq', choice({ pricing: free }), 'auto'), 'high');
  assert.equal(resolveSelectionEffort('groq', choice({}), 'auto'), 'high');
  assert.equal(resolveSelectionEffort('groq', choice({ pricing: 'variable' }), 'auto'), 'high');
  assert.equal(
    resolveSelectionEffort('groq', choice({ pricing: free }), 'auto', {
      estimatedInputTokens: AUTO_SUBSTANTIAL_TASK_TOKENS,
    }),
    'high',
  );
});

test('priced model: cost guard keeps light unless the task is substantial', () => {
  const model = choice({ pricing: priced });
  assert.equal(resolveSelectionEffort('groq', model, 'auto'), 'low');
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', { estimatedInputTokens: 5000 }),
    'low',
  );
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', {
      estimatedInputTokens: AUTO_SUBSTANTIAL_TASK_TOKENS,
    }),
    'high',
  );
});

test('Auto never exceeds the provider default, even for huge tasks', () => {
  const model = choice({ pricing: free });
  assert.equal(
    resolveSelectionEffort('groq', model, 'auto', { estimatedInputTokens: 1_000_000 }),
    'high',
  );
});

test('the resolved level always comes from the model effort list', () => {
  const narrow = choice({ efforts: ['minimal', 'medium'], pricing: free });
  const resolved = resolveSelectionEffort('google', narrow, 'auto');
  assert.ok(narrow.efforts.includes(resolved));
  assert.equal(resolved, 'medium');
  const narrowPriced = choice({ efforts: ['minimal', 'medium'], pricing: priced });
  assert.equal(resolveSelectionEffort('google', narrowPriced, 'auto'), 'minimal');
});

test('a model with no effort levels rejects instead of inventing one', () => {
  assert.throws(() => resolveSelectionEffort('groq', choice({ efforts: [] }), 'auto'), /no effort/);
});
