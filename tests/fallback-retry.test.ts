/**
 * Candidate-branch behavior tests for src/providers/pi/fallback.ts
 * (createTurnFallback), exercising the REAL module against stubbed
 * provider streams:
 *   - a retryable 429 that the session retry budget can still absorb is
 *     surfaced to the caller and NEVER moves to a backup mid-retry
 *     (no duplicate work, backup connection never opened);
 *   - once retries are exhausted, the same failure moves to the backup
 *     before any answer content was produced, reporting the failure;
 *   - an error AFTER answer content started never triggers a move
 *     (no replay of a partially-produced answer on another model);
 *   - when the failing candidate is the last one, the error surfaces.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTurnFallback } from '../src/providers/pi/fallback.ts';

function makeAccess(id, contextWindow = 100_000) {
  return {
    provider: 'openrouter',
    method: 'http',
    connectionId: `c-${id}`,
    effort: 'off',
    textModel: undefined,
    prepareRequest: undefined,
    definition: { choice: { id, name: `Model ${id}`, contextWindow, images: true } },
  };
}

function failedMessage(id, errorMessage) {
  return {
    role: 'assistant',
    content: [],
    api: 'openrouter',
    provider: 'openrouter',
    model: id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
}

function okMessage(id) {
  return { ...failedMessage(id, undefined), stopReason: 'stop', errorMessage: undefined };
}

function stubConnection(id) {
  return { model: { api: 'openrouter', provider: 'openrouter', id }, requestFacts: () => undefined };
}

function stubStream(events, result) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => result,
  };
}

function makeFallback({ primaryEvents, primaryResult, backups = [], retrying = () => false, spy }) {
  const primaryAccess = makeAccess('primary');
  const primaryConnection = stubConnection('primary');
  return createTurnFallback({
    primary: {
      access: primaryAccess,
      connection: primaryConnection,
      stream: () => stubStream(primaryEvents, primaryResult),
    },
    backups,
    start: 0,
    automatic: false,
    connect: (access) => {
      spy.connected.push(access.definition.choice.id);
      return Promise.resolve({
        ...stubConnection(access.definition.choice.id),
        runtime: {
          streamSimple: () =>
            stubStream(
              [{ type: 'text_delta', delta: 'answer' }],
              okMessage(access.definition.choice.id),
            ),
        },
      });
    },
    retrying,
    shared: () => 0,
    switched: (at) => spy.switched.push(at),
    moved: (from, to) => spy.moved.push([from, to]),
    failed: (message) => spy.failed.push(message),
  });
}

const RETRYABLE_429 = 'HTTP 429 too many requests (rate limit)';
const CONTEXT = { messages: [], systemPrompt: undefined };

test('retryable 429 during an available retry surfaces without touching backups', async () => {
  const spy = { connected: [], switched: [], moved: [], failed: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [{ type: 'start' }, { type: 'error', reason: 'error', error }],
    primaryResult: error,
    backups: [makeAccess('backup')],
    retrying: () => true,
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.equal(spy.connected.length, 0, 'backup connection must not be opened mid-retry');
  assert.equal(spy.moved.length, 0, 'no move to backup while retry budget remains');
});

test('exhausted retries move to the backup before any answer content', async () => {
  const spy = { connected: [], switched: [], moved: [], failed: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [{ type: 'start' }, { type: 'error', reason: 'error', error }],
    primaryResult: error,
    backups: [makeAccess('backup')],
    retrying: () => false,
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(spy.connected, ['backup']);
  assert.deepEqual(spy.moved, [[0, 1]]);
  assert.equal(spy.failed.length, 1);
  assert.equal(spy.failed[0].errorMessage, RETRYABLE_429);
});

test('an error after answer content started never moves to a backup', async () => {
  const spy = { connected: [], switched: [], moved: [], failed: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'text_delta', delta: 'partial answer' },
      { type: 'error', reason: 'error', error },
    ],
    primaryResult: error,
    backups: [makeAccess('backup')],
    retrying: () => false,
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.equal(spy.connected.length, 0, 'no replay of a started answer on another model');
  assert.equal(spy.moved.length, 0);
});

test('last candidate failure surfaces the error', async () => {
  const spy = { connected: [], switched: [], moved: [], failed: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [{ type: 'start' }, { type: 'error', reason: 'error', error }],
    primaryResult: error,
    backups: [],
    retrying: () => false,
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  for await (const _ of stream) void _;
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.equal(result.errorMessage, RETRYABLE_429);
});

function primaryTarget() {
  return { api: 'openrouter', provider: 'openrouter', id: 'primary' };
}
