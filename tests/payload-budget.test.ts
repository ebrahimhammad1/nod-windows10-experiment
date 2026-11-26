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
import { retryableRateLimitWait } from '../src/providers/pi/request-quota.ts';
import test from 'node:test';
import {
  learnRequestQuota,
  knownRequestQuota,
  quotaPreflightError,
  QUOTA_TTL_MS,
  PROBE_INTERVAL_MS,
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

const groq429 = () => () =>
  new Response(
    JSON.stringify({
      error: {
        message:
          'Rate limit reached for model `fixture-groq` in organization `fixture` on input tokens per minute (ITPM): Limit 7000, Used 3932, Requested 4074. Please try again in 0.4s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
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
  'nod_tool',
];

async function openSession(
  t: test.TestContext,
  opts?: { bigExec?: boolean; validatingMemory?: boolean },
) {
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
      if (opts?.validatingMemory && def.name === 'memory') {
        // Mirror the production bind() contract: invalid args are rejected
        // with a corrective error naming the tool and the failing path.
        const actions = ['memory_read', 'memory_find', 'history_search'];
        if (!actions.includes(String((args as any)?.action)))
          throw new Error(
            `Invalid memory arguments at /action: must be equal to one of the allowed values. Correct the arguments and call memory again.`,
          );
      }
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

test('the retry-hint parser reads Groq and Gemini pacing text and refuses long waits', () => {
  // Verbatim provider texts (ids/org trimmed); the Gemini one is the exact
  // wording from the user's gemini-3.8-flash 429 screenshot.
  const groq =
    'Rate limit reached for model `fixture-groq` on input tokens per minute (ITPM): Limit 7000, Used 3932, Requested 4074. Please try again in 8.61s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
  const gemini =
    'HTTP 429; status: Too Many Requests; status: RESOURCE_EXHAUSTED; You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: fixture-gemini, description: Generate content input tokens per minute limit exceeded on Free Tier. Please retry in 11.732249794s.; quotaMetric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count; quotaId: GenerateContentInputTokensPerModelPerMinute-FreeTier; quotaValue: 250000; retryDelay: 11s';
  assert.equal(retryableRateLimitWait(groq), 8610);
  assert.equal(retryableRateLimitWait(gemini), 11732.249794);
  assert.equal(
    retryableRateLimitWait('Request too large for model `fixture` on ITPM: Limit 7000, Requested 15463. Please reduce your message size.'),
    undefined,
    'a 413 oversize rejection carries no hint and must never be retried',
  );
  assert.equal(
    retryableRateLimitWait('Rate limit reached on requests per day (RPD): Limit 50. Please retry in 6h12m.'),
    undefined,
    'a daily quota has no seconds hint within the cap and must fail clearly',
  );
  assert.equal(
    retryableRateLimitWait('HTTP 429 Please retry in 45.5s.'),
    undefined,
    'a hint beyond the 30s cap fails clearly instead of being truncated',
  );
  assert.equal(
    retryableRateLimitWait('Please retry in 5.5s.'),
    undefined,
    'an unrelated error with retry wording but no 429 marker must not retry',
  );
});

test('a 429 per-minute rejection retries at the provider hint even with the billing upsell text, then completes', async (t) => {
  responders = [groq429(), textReply('after the wait')];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, events } = await openSession(t);
  const started = Date.now();
  await session.prompt('hi', []);
  const waited = Date.now() - started;
  assert.equal(REQUESTS.length, 2, 'the paced retry resends the same request once');
  assert.ok(waited >= 400, `the retry must honor the provider hint, waited ${waited}ms`);
  assert.ok(
    events.some((event) => event.type === 'retry'),
    `the retry must be visible, got: ${JSON.stringify(events.map((e) => e.type))}`,
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

test('a refused connection is probed every interval, so an upgrade is picked up within minutes', () => {
  const key = `quota-${randomUUID()}`;
  const at = 1_000_000;
  learnRequestQuota(key, 'Request too large for model `qwen-x` on tokens per minute (ITPM): Limit 100, Requested 15463', at);
  const context = { messages: [{ role: 'user', content: 'x'.repeat(10_000), timestamp: 0 }] } as never;
  // Immediately after the rejection the retry is refused locally (no probe yet).
  assert.ok(quotaPreflightError(key, context, at + 60_000));
  // After one probe interval the next request goes through to the provider:
  // if the limit rose it succeeds; if not, the provider rejects and re-teaches.
  assert.equal(quotaPreflightError(key, context, at + 60_000 + PROBE_INTERVAL_MS), undefined);
  // The probe armed the clock again: the request right behind it is refused.
  assert.ok(quotaPreflightError(key, context, at + 60_000 + PROBE_INTERVAL_MS + 1000));
});

test('the nod_tool gateway calls a deferred tool without declaring it', async (t) => {
  responders = [
    callReply('nod_tool', { name: 'memory', args: { action: 'memory_find', args: { query: 'x' } } }, 'call_g'),
    textReply('done'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed } = await openSession(t);
  await session.prompt('check my memory for x', []);
  assert.equal(REQUESTS.length, 2, 'gateway call + answer, no search round trip');
  assert.ok(executed.includes('memory'), 'the gateway dispatched to memory');
  for (const [index, request] of REQUESTS.entries())
    assert.ok(
      !(request.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name).includes('memory'),
      `memory must never be declared (request ${index})`,
    );
  await session.dispose();
});

test('the nod_tool gateway refuses always-on and unknown tools with a corrective error', async (t) => {
  responders = [
    callReply('nod_tool', { name: 'send_message', args: {} }, 'call_g'),
    textReply('recovered'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed } = await openSession(t);
  await session.prompt('try the gateway on send_message', []);
  assert.ok(!executed.includes('send_message'), 'an always-on tool must not be dispatched');
  const resultMessage = JSON.stringify(REQUESTS[1].messages.at(-1));
  assert.match(resultMessage, /nod_tool_search/);
  await session.dispose();
});

test('tools loaded on demand are evicted at the next owner turn', async (t) => {
  responders = [
    callReply('nod_tool_search', { query: 'memory' }, 'call_s'),
    callReply('memory', { action: 'memory_find', args: { query: 'x' } }, 'call_m'),
    textReply('done'),
    textReply('next answer'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed } = await openSession(t);
  await session.prompt('check my memory for x', []);
  assert.ok(executed.includes('memory'));
  assert.ok(declared(1).includes('memory'), 'loaded within the turn');
  await session.prompt('one more thing', []);
  const last = REQUESTS.length - 1;
  assert.ok(!declared(last).includes('memory'), 'evicted at the next owner turn');
  assert.ok(declared(last).includes('nod_tool_search'), 'discovery stays available');
  await session.dispose();
});

test('a model that calls the gateway with wrong args recovers from the corrective error', async (t) => {
  responders = [
    callReply('nod_tool', { name: 'memory', args: { action: 'remember everything' } }, 'call_bad'),
    callReply('nod_tool', { name: 'memory', args: { action: 'memory_find', args: { query: 'x' } } }, 'call_good'),
    textReply('done'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed } = await openSession(t, { validatingMemory: true });
  await session.prompt('check my memory for x', []);
  assert.equal(REQUESTS.length, 3, 'wrong call, corrected call, answer');
  assert.equal(
    executed.filter((name) => name === 'memory').length,
    1,
    'only the valid call executed',
  );
  // The corrective error reached the model as the tool result of the bad call.
  const afterError = JSON.stringify(REQUESTS[1].messages.at(-1));
  assert.match(afterError, /Invalid memory arguments/);
  await session.dispose();
});

test('a model that guesses an unknown tool name is sent to discovery, not executed', async (t) => {
  responders = [
    callReply('nod_tool', { name: 'emails', args: {} }, 'call_bad'),
    callReply('nod_tool_search', { query: 'email' }, 'call_s'),
    textReply('done'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed } = await openSession(t);
  await session.prompt('read my latest email', []);
  assert.ok(!executed.includes('emails'), 'an unknown name never executes');
  const afterError = JSON.stringify(REQUESTS[1].messages.at(-1));
  assert.match(afterError, /nod_tool_search/);
  await session.dispose();
});

test('minimal loadout declares five tools and reaches sandbox tools through the gateway', async (t) => {
  process.env.NOD_TOOL_LOADOUT = 'minimal';
  t.after(() => delete process.env.NOD_TOOL_LOADOUT);
  responders = [
    callReply('nod_tool', { name: 'bash', args: { command: 'echo ok' } }, 'call_b'),
    textReply('done'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session } = await openSession(t);
  await session.prompt('run a quick command', []);
  assert.deepEqual(
    [...declared(0)].sort(),
    ['ask_user', 'codemode', 'nod_tool', 'nod_tool_search', 'send_message'],
    `minimal declared set changed: ${declared(0).join(',')}`,
  );
  assert.equal(REQUESTS.length, 2, 'gateway call + answer');
  const resultMessage = JSON.stringify(REQUESTS[1].messages.at(-1));
  assert.match(resultMessage, /"role":"tool"/, 'a tool result came back');
  assert.doesNotMatch(resultMessage, /isError|Invalid|not one/, 'the sandbox call succeeded');
  await session.dispose();
});
