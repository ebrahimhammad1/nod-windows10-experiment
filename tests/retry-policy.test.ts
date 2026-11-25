/**
 * Behavior tests for the retry policy the fork now applies to every turn
 * (pi/index.ts: { baseDelayMs: 4000, maxRetries: 1 }) using the REAL
 * retryAssistantCall from @earendil-works/pi-ai:
 *   - a retryable 429 is retried exactly once (bounded), then succeeds;
 *   - a non-retryable quota/billing failure is NOT retried;
 *   - an aborted request is NOT retried;
 *   - the retry delay follows the configured base delay backoff;
 *   - a request that keeps failing surfaces the final error after the
 *     single allowed retry (no unbounded replay).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { retryAssistantCall } from '@earendil-works/pi-ai';

const POLICY = { enabled: true, maxRetries: 1, baseDelayMs: 4000 };

function message(stopReason, errorMessage) {
  return {
    role: 'assistant',
    content: [],
    api: 'openrouter',
    provider: 'openrouter',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

test('retryable 429 is retried exactly once with the configured backoff', async () => {
  let calls = 0;
  const scheduled = [];
  const result = await retryAssistantCall(
    async () => {
      calls++;
      return calls === 1 ? message('error', 'HTTP 429 too many requests') : message('stop');
    },
    POLICY,
    undefined,
    { onRetryScheduled: (attempt, max, delayMs) => scheduled.push({ attempt, max, delayMs }) },
  );
  assert.equal(result.stopReason, 'stop');
  assert.equal(calls, 2, 'one produce retry, bounded by maxRetries');
  assert.deepEqual(scheduled, [{ attempt: 1, max: 1, delayMs: 4000 }]);
});

test('non-retryable quota failure is not retried', async () => {
  let calls = 0;
  const result = await retryAssistantCall(
    async () => {
      calls++;
      return message('error', 'insufficient_quota: billing hard limit reached');
    },
    POLICY,
    undefined,
    undefined,
  );
  assert.equal(result.stopReason, 'error');
  assert.equal(calls, 1, 'quota/billing failures fail fast');
});

test('aborted request is not retried', async () => {
  let calls = 0;
  const result = await retryAssistantCall(
    async () => {
      calls++;
      return message('aborted');
    },
    POLICY,
    undefined,
    undefined,
  );
  assert.equal(result.stopReason, 'aborted');
  assert.equal(calls, 1);
});

test('persistent failure surfaces after the single allowed retry', async () => {
  let calls = 0;
  const result = await retryAssistantCall(
    async () => {
      calls++;
      return message('error', 'HTTP 429 too many requests');
    },
    POLICY,
    undefined,
    undefined,
  );
  assert.equal(result.stopReason, 'error');
  assert.equal(calls, 2, 'no unbounded replay of the failing request');
});
