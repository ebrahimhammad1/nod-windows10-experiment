// Payload budget tests: the per-request tool payload stays small, deferred
// tools still load and execute, and a connection that reported a per-minute
// input limit gets a local preflight refusal instead of another doomed
// request. Uses the real tool definitions and the real Pi session stack with a
// mocked fetch, so the measured request is the actual provider payload.
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  learnRequestQuota,
  knownRequestQuota,
  quotaPreflightError,
  QUOTA_TTL_MS,
} from '../src/providers/pi/request-quota.ts';

const REQUESTS: any[] = [];
let responders: Array<() => Response> = [];
let callIndex = 0;

function sse(parts: object[]): Response {
  const body = parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta: any, finish: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'fixture-groq',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
});
const textReply = (text: string) => () =>
  sse([chunk({ role: 'assistant', content: text }), chunk({}, 'stop')]);
const callReply = (name: string, args: any, id: string) => () =>
  sse([
    chunk({
      role: 'assistant',
      tool_calls: [
        { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    }),
    chunk({}, 'tool_calls'),
  ]);
const groq413 = () => () =>
  new Response(
    JSON.stringify({
      error: {
        message:
          'Request too large for model `fixture-groq` in organization `fixture` on input tokens per minute (ITPM): Limit 7000, Requested 15463. Please reduce your message size.',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    }),
    { status: 413, headers: { 'content-type': 'application/json' } },
  );

(globalThis as any).fetch = async (_url: any, init: any) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {}
  if (parsed && Array.isArray(parsed.messages)) {
    REQUESTS.push(parsed);
    const responder = responders[Math.min(callIndex, responders.length - 1)]!;
    callIndex++;
    return responder();
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

const CORE_DECLARED = [
  'read',
  'bash',
  'edit',
  'write',
  'skills',
  'send_message',
  'ask_user',
  'apps',
  'share_file',
  'codemode',
  'nod_tool_search',
];

async function openSession(t: test.TestContext, opts?: { bigExec?: boolean }) {
  const modelId = `fixture-${randomUUID().slice(0, 8)}`;
  const { createPiAgent } = await import('../src/providers/pi/index.ts');
  const { toolDefinitions } = await import('../src/runtime/tools.ts');
  const { systemPrompt } = await import('../src/runtime/prompt.ts');
  const sessionRoot = await mkdtemp(join(tmpdir(), 'nod-payload-test-'));
  t.after(() => agent.dispose());
  const workspace: any = {
    path: join(sessionRoot, 'ws'),
    instructions: 'Fixture workspace only.',
    exec: async (input: any) => ({
      exitCode: 0,
      stdout:
        opts?.bigExec && String(input?.command ?? '').includes('big') ? 'x'.repeat(30_000) : 'ok',
      stderr: '',
    }),
  };
  const executed: string[] = [];
  const tools = Object.values(toolDefinitions as Record<string, any>).map((def: any) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    ...(def.eager ? { eager: true } : {}),
    ...(def.companions?.length ? { companions: def.companions } : {}),
    execute: async (args: any) => {
      executed.push(def.name);
      return { content: [{ type: 'text' as const, text: `${def.name} fixture result` }] };
    },
  }));
  const events: any[] = [];
  const agent = createPiAgent({
    provider: 'compatible',
    sessionRoot,
    resolve: async () =>
      ({
        provider: 'compatible',
        method: 'api_key',
        effort: 'off',
        read: async () => ({ type: 'endpoint', url: 'http://127.0.0.1:1/v1', key: 'fixture-key' }),
        definition: {
          choice: {
            id: modelId,
            name: modelId,
            efforts: ['off'],
            images: false,
            contextWindow: 131_072,
          },
          spec: {
            id: modelId,
            name: modelId,
            provider: 'compatible',
            api: 'openai-completions',
            baseUrl: 'http://127.0.0.1:1/v1',
            reasoning: false,
            input: ['text'],
            contextWindow: 131_072,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
          },
        },
      }) as any,
  });
  const session = await agent.open({
    threadId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    runId: randomUUID(),
    browserId: '',
    systemPrompt: systemPrompt(workspace, undefined, undefined),
    ownerContext: 'Owner context fixture.',
    tools: tools as any,
    workspace,
    runTool: async (_n: string, _p: unknown, run: any) => run(),
    onEvent: (event: any) => events.push(event),
    shouldStop: () => false,
  } as any);
  return { session, executed, events };
}

function declared(index: number): string[] {
  return (REQUESTS[index]?.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name);
}

test('a fresh chat request declares only the small core tool set', async (t) => {
  responders = [textReply('Hello!')];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session } = await openSession(t);
  await session.prompt('hi', []);
  const toolsJson = JSON.stringify(REQUESTS[0].tools ?? []).length;
  const total = JSON.stringify(REQUESTS[0]).length;
  assert.deepEqual([...declared(0)].sort(), [...CORE_DECLARED].sort());
  // Budget guard: was 24,284 bytes of tool schemas (about 15.5k provider
  // tokens with the system prompt) before on-demand loading.
  assert.ok(toolsJson < 12_000, `tool declarations grew to ${toolsJson} bytes`);
  assert.ok(total < 30_000, `whole request grew to ${total} bytes`);
  await session.dispose();
});

test('deferred tools load through nod_tool_search and still execute', async (t) => {
  responders = [
    callReply('nod_tool_search', { query: 'memory' }, 'call_s'),
    callReply('memory', { action: 'memory_find', args: { query: 'x' } }, 'call_m'),
    textReply('done'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed } = await openSession(t);
  await session.prompt('check my memory for x', []);
  assert.ok(!declared(0).includes('memory'), 'memory must not be declared upfront');
  assert.ok(declared(1).includes('memory'), 'memory must be declared after the search');
  assert.ok(executed.includes('memory'), 'memory must execute after loading');
  // A default search stays small; the model can ask for more explicitly.
  assert.ok(
    declared(1).length <= CORE_DECLARED.length + 4,
    `a default search loaded too many tools: ${declared(1).join(',')}`,
  );
  await session.dispose();
});

test('large tool results stay bounded as the conversation grows', async (t) => {
  responders = [
    textReply('Hello!'),
    callReply('bash', { command: 'echo big' }, 'call_1'),
    textReply('Done.'),
    callReply('bash', { command: 'echo big' }, 'call_2'),
    textReply('Done again.'),
    textReply('Final.'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session } = await openSession(t, { bigExec: true });
  await session.prompt('hi', []);
  await session.prompt('run the big listing', []);
  await session.prompt('again', []);
  await session.prompt('and the final question?', []);
  const first = JSON.stringify(REQUESTS[0]).length;
  const last = JSON.stringify(REQUESTS.at(-1)).length;
  // Two 30k tool outputs must not grow the request by more than a fraction of
  // their size; oversized output is saved to the workspace with a preview.
  assert.ok(
    last - first < 10_000,
    `request grew by ${last - first} bytes across two 30k tool results`,
  );
  await session.dispose();
});

test('a learned per-minute input limit refuses the next oversized request locally', async (t) => {
  responders = [groq413()];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, events } = await openSession(t);
  await session.prompt('hi', []);
  assert.equal(REQUESTS.length, 1, 'the first request reaches the provider');
  assert.ok(
    events.some(
      (event) => event.type === 'error' && /request too large/i.test(String(event.message)),
    ),
    `the provider rejection must surface, got: ${JSON.stringify(events.map((e) => e.type))}`,
  );

  // The connection's limit is now known; an identical request must be refused
  // before it is built and sent again.
  await session.prompt('hi again', []);
  assert.equal(REQUESTS.length, 1, 'the second request must not be sent');
  const refused = events.filter(
    (event) => event.type === 'error' && /did not send this request/i.test(String(event.message)),
  );
  assert.ok(
    refused.length > 0,
    `expected a local preflight refusal, got: ${JSON.stringify(
      events.map((e) => (e.type === 'error' ? String(e.message).slice(0, 120) : e.type)),
    )}`,
  );
  assert.match(String(refused[0]!.message), /7,000/);
  await session.dispose();
});

test('an unknown quota is not guessed: requests proceed without a learned limit', async (t) => {
  const { knownRequestQuota } = await import('../src/providers/pi/request-quota.ts');
  assert.equal(knownRequestQuota('compatible/api_key/never-seen-model'), undefined);
  responders = [textReply('fine')];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session } = await openSession(t);
  await session.prompt('hi', []);
  assert.equal(REQUESTS.length, 1, 'with no learned quota the request is sent');
  await session.dispose();
});

test('a learned limit updates in both directions and expires so it cannot lock a connection', () => {
  const key = `quota-${randomUUID()}`;
  const at = 1_000_000;
  // Learn a strict limit, then a higher one (tier upgrade): newest report wins.
  learnRequestQuota(key, 'Request too large for model `qwen-x` on tokens per minute (ITPM): Limit 7000, Requested 15463', at);
  assert.equal(knownRequestQuota(key, at)?.limit, 7000);
  learnRequestQuota(key, 'Request too large for model `qwen-x` on tokens per minute (ITPM): Limit 12000, Requested 15463', at + 1000);
  assert.equal(knownRequestQuota(key, at + 1000)?.limit, 12000);
  // And a stricter one (plan downgrade): newest wins downward too.
  learnRequestQuota(key, 'Request too large for model `qwen-x` on tokens per minute (ITPM): Limit 5000, Requested 15463', at + 2000);
  assert.equal(knownRequestQuota(key, at + 2000)?.limit, 5000);
  // After the TTL the learned limit expires: the next request proceeds and
  // either succeeds or re-learns the current limit from the provider.
  assert.equal(knownRequestQuota(key, at + 2000 + QUOTA_TTL_MS), undefined);
});

test('the preflight refusal states the estimate basis and the re-check path', () => {
  const key = `quota-${randomUUID()}`;
  const at = 1_000_000;
  learnRequestQuota(key, 'Request too large for model `qwen-x` on tokens per minute (ITPM): Limit 100, Requested 15463', at);
  const error = quotaPreflightError(
    key,
    { messages: [{ role: 'user', content: 'x'.repeat(10_000), timestamp: 0 }] } as never,
    at + 60_000,
  );
  assert.ok(error);
  assert.match(error!.message, /estimate/i);
  assert.match(error!.message, /100/);
  assert.match(error!.message, /re-checked/i);
});
