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
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from '@earendil-works/pi-ai';
import type { ModelAccess } from '../src/ports/models.ts';
import type { createPiModelRuntime } from '../src/providers/pi/models.ts';
import { createTurnFallback } from '../src/providers/pi/fallback.ts';
import { learnRequestQuota } from '../src/providers/pi/request-quota.ts';

type Connection = Awaited<ReturnType<typeof createPiModelRuntime>>;
type Spy = {
  connected: string[];
  switched: number[];
  moved: [number, number][];
  failed: AssistantMessage[];
  reasoning: Array<string | undefined>;
};

function makeAccess(id: string, contextWindow = 100_000, opts: { auto?: boolean } = {}): ModelAccess {
  return {
    provider: 'openrouter',
    method: 'http',
    connectionId: `c-${id}`,
    effort: opts.auto ? 'high' : 'off',
    ...(opts.auto ? { effortAuto: true } : {}),
    textModel: undefined,
    prepareRequest: undefined,
    definition: {
      choice: {
        id,
        name: `Model ${id}`,
        contextWindow,
        images: true,
        efforts: ['low', 'high'],
        pricing: { input: 0, output: 0 },
      },
    },
  } as unknown as ModelAccess;
}

function failedMessage(id: string, errorMessage?: string): AssistantMessage {
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
  } as unknown as AssistantMessage;
}

function okMessage(id: string): AssistantMessage {
  return { ...failedMessage(id, undefined), stopReason: 'stop', errorMessage: undefined };
}

function stubConnection(
  id: string,
  spy?: Spy,
  thinkingLevelMap: Record<string, string | null> = { off: null, low: 'low', high: 'high' },
): Connection {
  return {
    model: { api: 'openrouter', provider: 'openrouter', id, reasoning: true, thinkingLevelMap },
    requestFacts: () => undefined,
    runtime: {
      streamSimple: (_model: unknown, _context: unknown, options?: { reasoning?: string }) => {
        spy?.reasoning.push(options?.reasoning);
        return stubStream([{ type: 'text_delta', delta: 'answer' } as AssistantMessageEvent], okMessage(id));
      },
    },
  } as unknown as Connection;
}

function stubStream(
  events: AssistantMessageEvent[],
  result: AssistantMessage,
): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => result,
  } as unknown as AssistantMessageEventStream;
}

function makeFallback({
  primaryEvents,
  primaryResult,
  backups = [],
  retrying = () => false,
  spy,
  primaryAuto,
  backupThinkingLevelMap,
}: {
  primaryEvents: AssistantMessageEvent[];
  primaryResult: AssistantMessage;
  backups?: ModelAccess[];
  retrying?: () => boolean;
  spy: Spy;
  primaryAuto?: boolean;
  backupThinkingLevelMap?: Record<string, string | null>;
}) {
  const primaryAccess = makeAccess('primary', 100_000, { auto: primaryAuto });
  const primaryConnection = stubConnection('primary');
  return createTurnFallback({
    primary: {
      access: primaryAccess,
      connection: primaryConnection,
      stream: (_target: unknown, _context: unknown, options?: { reasoning?: string }) => {
        spy.reasoning.push(options?.reasoning);
        return stubStream(primaryEvents, primaryResult);
      },
    },
    backups,
    start: 0,
    automatic: false,
    connect: (access: ModelAccess) => {
      spy.connected.push(access.definition.choice.id);
      return Promise.resolve(
        stubConnection(access.definition.choice.id, spy, backupThinkingLevelMap),
      );
    },
    retrying,
    shared: () => 0,
    switched: (at) => spy.switched.push(at),
    moved: (from, to) => spy.moved.push([from, to]),
    failed: (message) => spy.failed.push(message),
  });
}

const RETRYABLE_429 = 'HTTP 429 too many requests (rate limit)';
const CONTEXT = { messages: [], systemPrompt: undefined } as unknown as Context;

test('retryable 429 during an available retry surfaces without touching backups', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
    primaryResult: error,
    backups: [makeAccess('backup')],
    retrying: () => true,
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.equal(spy.connected.length, 0, 'backup connection must not be opened mid-retry');
  assert.equal(spy.moved.length, 0, 'no move to backup while retry budget remains');
});

test('exhausted retries move to the backup before any answer content', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
    primaryResult: error,
    backups: [makeAccess('backup')],
    retrying: () => false,
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(spy.connected, ['backup']);
  assert.deepEqual(spy.moved, [[0, 1]]);
  assert.equal(spy.failed.length, 1);
  assert.equal(spy.failed[0].errorMessage, RETRYABLE_429);
});

test('an error after answer content started never moves to a backup', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'text_delta', delta: 'partial answer' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
    primaryResult: error,
    backups: [makeAccess('backup')],
    retrying: () => false,
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, 'error');
  assert.equal(spy.connected.length, 0, 'no replay of a started answer on another model');
  assert.equal(spy.moved.length, 0);
});

test('last candidate failure surfaces the error', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
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

function primaryTarget(): Model<Api> {
  return { api: 'openrouter', provider: 'openrouter', id: 'primary' } as unknown as Model<Api>;
}

const COMPLEX_CONTEXT = {
  messages: [{ role: 'user', content: 'fix this please:\n```\nconst x =\n```' }],
  systemPrompt: undefined,
} as unknown as Context;

test('auto candidates resolve per candidate: backup tight quota stays light', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const backup = makeAccess('autoq', 100_000, { auto: true });
  // The BACKUP's own connection reported a tight per-minute limit.
  learnRequestQuota(
    'c-autoq/http/autoq',
    'HTTP 429 request too large: tokens per minute (TPM): Limit 7000, Requested 9000',
  );
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
    primaryResult: error,
    backups: [backup],
    spy,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  for await (const _ of stream) void _;
  await stream.result();
  assert.deepEqual(spy.connected, ['autoq']);
  // Primary is manual: its stream options pass through untouched (no
  // reasoning override). The auto backup served at its own lightest level.
  assert.deepEqual(spy.reasoning, [undefined, 'low']);
});

test('auto backup resolves to its own provider default on a complex prompt', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const backup = makeAccess('autoc', 100_000, { auto: true });
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
    primaryResult: error,
    backups: [backup],
    spy,
  });
  const stream = fallback.stream(primaryTarget(), COMPLEX_CONTEXT, undefined);
  for await (const _ of stream) void _;
  await stream.result();
  // Small payload but structural complexity: provider default, not lightest.
  assert.deepEqual(spy.reasoning, [undefined, 'high']);
});

test('auto backup never invents a level its model does not map', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const backup = makeAccess('autolow', 100_000, { auto: true });
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
    primaryResult: error,
    backups: [backup],
    spy,
    // Only 'low' is mapped: every other level must clamp down to it.
    backupThinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: null },
  });
  const stream = fallback.stream(primaryTarget(), COMPLEX_CONTEXT, undefined);
  for await (const _ of stream) void _;
  await stream.result();
  assert.deepEqual(spy.reasoning, [undefined, 'low']);
});

test('manual backup level is never adapted', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const backup = { ...makeAccess('manual'), effort: 'low' } as ModelAccess;
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'error', reason: 'error', error },
    ] as AssistantMessageEvent[],
    primaryResult: error,
    backups: [backup],
    spy,
  });
  const stream = fallback.stream(primaryTarget(), COMPLEX_CONTEXT, undefined);
  for await (const _ of stream) void _;
  await stream.result();
  assert.deepEqual(spy.reasoning, [undefined, 'low']);
});

test('auto primary inside a fallback chain adapts per request', async () => {
  const spy: Spy = { connected: [], switched: [], moved: [], failed: [], reasoning: [] };
  const error = failedMessage('primary', RETRYABLE_429);
  const fallback = makeFallback({
    primaryEvents: [
      { type: 'start' },
      { type: 'text_delta', delta: 'answer' },
    ] as AssistantMessageEvent[],
    primaryResult: okMessage('primary'),
    backups: [],
    spy,
    primaryAuto: true,
  });
  const stream = fallback.stream(primaryTarget(), CONTEXT, undefined);
  for await (const _ of stream) void _;
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop');
  // Simple turn on the primary's own free model: lightest level.
  assert.deepEqual(spy.reasoning, ['low']);
});
