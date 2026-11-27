import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { MemoryCurator } from '../src/ports/memory-curator.ts';
import type { RuntimeContext } from '../src/ports/agent.ts';
import type { MemoryService } from '../src/server/memory.ts';
import { createMemoryRecall } from '../src/server/memory-recall.ts';

// Empty-store short-circuit boundary: the memory-select (plan) and
// source-recall (rank) curator calls are consumption-bearing model calls.
// They must NOT fire when every relevant store is empty (nothing to
// select), and they MUST fire whenever any relevant record exists
// (conversation history, related conversation, or memory notes) or when
// the store state is unknown, because the plan call's query expansion and
// the rank call's filtering operate on real archive records and skipping
// them would change recall behavior.

function fixture(overrides: {
  notes?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
  relatedConversation?: Array<Record<string, unknown>>;
  viewError?: Error;
  planAnswer?: unknown;
}) {
  const curatorCalls: string[] = [];
  const poolQueries: string[] = [];
  const findCalls: unknown[] = [];
  const pool = {
    async query(text: string) {
      poolQueries.push(text);
      throw new Error('pool must not be queried in this fixture');
    },
  } as unknown as Pick<Pool, 'query'>;
  const memory = {
    async view() {
      if (overrides.viewError) throw overrides.viewError;
      return { notes: overrides.notes ?? [] };
    },
    async find(input: unknown) {
      findCalls.push(input);
      return [];
    },
  } as unknown as MemoryService;
  const curator = {
    id: 'fixture',
    configured: true,
    async curate({ instructions }: { instructions: string }) {
      curatorCalls.push(instructions);
      return overrides.planAnswer ?? { mode: 'none', paths: [], queries: [] };
    },
  } as unknown as MemoryCurator;
  const recall = createMemoryRecall({ pool, ownerId: 'owner-a', memory, curator });
  const context = {
    prompt: 'What is the weather like tomorrow?',
    signal: new AbortController().signal,
    history: overrides.history ?? [],
    ...(overrides.relatedConversation
      ? { relatedConversation: overrides.relatedConversation }
      : {}),
  } as unknown as RuntimeContext;
  return { recall, context, curatorCalls, poolQueries, findCalls };
}

test('empty stores: prepare makes no curator calls, no memory find, no DB queries', async () => {
  const { recall, context, curatorCalls, poolQueries, findCalls } = fixture({});
  const brief = await recall.prepare(context);
  assert.equal(brief, undefined);
  assert.equal(curatorCalls.length, 0);
  assert.equal(findCalls.length, 0);
  assert.equal(poolQueries.length, 0);
});

test('conversation history present with empty notes: plan call fires (records exist)', async () => {
  const { recall, context, curatorCalls } = fixture({
    history: [{ role: 'user', text: 'Earlier question in this thread.' }],
  });
  const brief = await recall.prepare(context);
  assert.equal(brief, undefined); // plan answered mode none
  assert.equal(curatorCalls.length, 1);
  assert.match(curatorCalls[0], /Select memory for the current request/);
});

test('related conversation present with empty notes and history: plan call fires', async () => {
  const { recall, context, curatorCalls } = fixture({
    relatedConversation: [{ role: 'user', text: 'Related earlier thread.' }],
  });
  const brief = await recall.prepare(context);
  assert.equal(brief, undefined);
  assert.equal(curatorCalls.length, 1);
});

test('memory notes present with empty history: plan call fires', async () => {
  const { recall, context, curatorCalls } = fixture({
    notes: [
      {
        path: 'about/tea',
        text: 'Prefers mint tea.',
        status: 'stated',
        fact: 'Prefers mint tea.',
        expires: null,
        sources: [],
      },
    ],
  });
  const brief = await recall.prepare(context);
  assert.equal(brief, undefined);
  assert.equal(curatorCalls.length, 1);
});

test('store load unknown (view throws): prepare surfaces the error, never silently skips', async () => {
  const { recall, context, curatorCalls } = fixture({
    viewError: new Error('memory store unavailable'),
  });
  await assert.rejects(recall.prepare(context), /memory store unavailable/);
  assert.equal(curatorCalls.length, 0);
});

test('curator not configured: no curator calls, falls back to search-only plan', async () => {
  const { recall, context, curatorCalls, poolQueries } = fixture({
    notes: [
      {
        path: 'about/tea',
        text: 'Prefers mint tea.',
        status: 'stated',
        fact: 'Prefers mint tea.',
        expires: null,
        sources: [],
      },
    ],
  });
  const unconfigured = createMemoryRecall({
    pool: {
      async query() {
        poolQueries.push('q');
        return { rows: [] };
      },
    } as unknown as Pick<Pool, 'query'>,
    ownerId: 'owner-a',
    memory: {
      async view() {
        return {
          notes: [
            {
              path: 'about/tea',
              text: 'Prefers mint tea.',
              status: 'stated',
              fact: 'Prefers mint tea.',
              expires: null,
              sources: [],
            },
          ],
        };
      },
      async find() {
        return [{ path: 'about/tea' }];
      },
    } as unknown as MemoryService,
    curator: { id: 'fixture', configured: false } as unknown as MemoryCurator,
  });
  const brief = await unconfigured.prepare(context);
  assert.equal(curatorCalls.length, 0);
  // fallback plan mode recall ran archive searches (no messages found) and
  // still surfaces the note from the fallback find
  assert.ok(brief);
  assert.deepEqual(
    brief.facts.map((fact) => fact.path),
    ['about/tea'],
  );
  assert.equal(brief.messages.length, 0);
  assert.ok(poolQueries.length > 0);
});
