/**
 * Policy tests for resolveSelectionEffort (Auto effort mode):
 *   - concrete levels pass through untouched;
 *   - a single-level model resolves to that level (the owner's qwen
 *     connection exposes only 'off');
 *   - free/unpriced models resolve to the provider default level;
 *   - priced models resolve to the lightest level (cost guard);
 *   - the resolved level is ALWAYS from the model's own effort list - no
 *     provider-unsupported level is ever invented.
 * No network: pure function against the REAL module.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSelectionEffort } from '../src/shared/model-defaults.ts';
import type { ModelChoice } from '../src/shared/models.ts';

const choice = (over: Partial<ModelChoice>): ModelChoice => ({
  id: 'fixture-model',
  name: 'Fixture',
  efforts: ['low', 'high'],
  images: false,
  contextWindow: 64_000,
  ...over,
});

test('concrete levels pass through', () => {
  assert.equal(resolveSelectionEffort('groq', choice({}), 'low'), 'low');
  assert.equal(resolveSelectionEffort('groq', choice({}), 'high'), 'high');
});

test('single-level model resolves to its only level', () => {
  assert.equal(resolveSelectionEffort('groq', choice({ efforts: ['off'] }), 'auto'), 'off');
});

test('free model resolves to the provider default (high when supported)', () => {
  const free = choice({ pricing: { input: 0, output: 0 } });
  assert.equal(resolveSelectionEffort('groq', free, 'auto'), 'high');
});

test('unpriced and variable-priced models also resolve to the default', () => {
  assert.equal(resolveSelectionEffort('groq', choice({}), 'auto'), 'high');
  assert.equal(resolveSelectionEffort('groq', choice({ pricing: 'variable' }), 'auto'), 'high');
});

test('priced model resolves to the lightest level (cost guard)', () => {
  const priced = choice({ pricing: { input: 1, output: 2 } });
  assert.equal(resolveSelectionEffort('groq', priced, 'auto'), 'low');
});

test('the resolved level always comes from the model effort list', () => {
  const narrow = choice({ efforts: ['minimal', 'medium'], pricing: { input: 0, output: 0 } });
  const resolved = resolveSelectionEffort('google', narrow, 'auto');
  assert.ok(narrow.efforts.includes(resolved));
  assert.equal(resolved, 'medium');
  const narrowPriced = choice({ efforts: ['minimal', 'medium'], pricing: { input: 1, output: 1 } });
  assert.equal(resolveSelectionEffort('google', narrowPriced, 'auto'), 'minimal');
});

test('a model with no effort levels rejects instead of inventing one', () => {
  assert.throws(() => resolveSelectionEffort('groq', choice({ efforts: [] }), 'auto'), /no effort/);
});
