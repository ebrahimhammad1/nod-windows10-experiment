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
import { retryAssistantCall, type AssistantMessage } from '@earendil-works/pi-ai';

import {
  RETRY_BASE_DELAY_MS,
  RETRY_JITTER_MS,
  RETRY_MAX_DELAY_MS,
  turnRetryPolicy,
} from '../src/providers/pi/retry-policy';

const POLICY = { enabled: true, maxRetries: 1, baseDelayMs: 4000 };

function message(stopReason: string, errorMessage?: string): AssistantMessage {
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
  } as unknown as AssistantMessage;
}

test('retryable 429 is retried exactly once with the configured backoff', async () => {
  let calls = 0;
  const scheduled: Array<{ attempt: number; max: number; delayMs: number }> = [];
  const result = await retryAssistantCall(
    async () => {
      calls++;
      return calls === 1 ? message('error', 'HTTP 429 too many requests') : message('stop');
    },
    POLICY,
    undefined,
    { onRetryScheduled: (attempt, max, delayMs) => {
        scheduled.push({ attempt, max, delayMs });
      } },
  );
  assert.equal(result.stopReason, 'stop');
  assert.equal(calls, 2, 'one produce retry, bounded by maxRetries');
  assert.deepEqual(scheduled, [{ attempt: 1, max: 1, delayMs: 4000 }]);
});

test('turn policy is one retry with a jittered 4-6s base delay', () => {
  for (const random of [() => 0, () => 0.999, Math.random]) {
    const policy = turnRetryPolicy(random);
    assert.equal(policy.maxRetries, 1);
    assert.ok(policy.baseDelayMs >= RETRY_BASE_DELAY_MS);
    assert.ok(policy.baseDelayMs < RETRY_BASE_DELAY_MS + RETRY_JITTER_MS);
    assert.equal(policy.maxAgentDelayMs, RETRY_MAX_DELAY_MS);
  }
});

test('provider retry-after hint is honored and never shortened', async () => {
  const scheduled: Array<{ attempt: number; max: number; delayMs: number }> = [];
  const result = await retryAssistantCall(
    async () => message('error', 'HTTP 429 too many requests, retry after 12s'),
    { enabled: true, maxRetries: 1, baseDelayMs: 4000, maxAgentDelayMs: RETRY_MAX_DELAY_MS },
    undefined,
    { onRetryScheduled: (attempt, max, delayMs) => {
        scheduled.push({ attempt, max, delayMs });
      } },
  );
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(scheduled, [{ attempt: 1, max: 1, delayMs: 12_000 }]);
});

test('a provider hint beyond the cap fails fast instead of retrying early', async () => {
  let calls = 0;
  const scheduled: Array<{ attempt: number; max: number; delayMs: number }> = [];
  const result = await retryAssistantCall(
    async () => {
      calls++;
      return message('error', 'HTTP 429 too many requests, retry after 120s');
    },
    { enabled: true, maxRetries: 1, baseDelayMs: 4000, maxAgentDelayMs: RETRY_MAX_DELAY_MS },
    undefined,
    { onRetryScheduled: (attempt, max, delayMs) => {
        scheduled.push({ attempt, max, delayMs });
      } },
  );
  assert.equal(result.stopReason, 'error');
  assert.equal(calls, 1, 'no retry earlier than the provider hint');
  assert.deepEqual(scheduled, [], 'no retry scheduled when the hint exceeds the cap');
});

test('computed delay is capped at the 30s maximum', async () => {
  const scheduled: Array<{ attempt: number; max: number; delayMs: number }> = [];
  await retryAssistantCall(
    async () => message('error', 'HTTP 429 too many requests'),
    { enabled: true, maxRetries: 1, baseDelayMs: 120_000, maxAgentDelayMs: RETRY_MAX_DELAY_MS },
    undefined,
    { onRetryScheduled: (attempt, max, delayMs) => {
        scheduled.push({ attempt, max, delayMs });
      } },
  );
  assert.deepEqual(scheduled, [{ attempt: 1, max: 1, delayMs: RETRY_MAX_DELAY_MS }]);
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
