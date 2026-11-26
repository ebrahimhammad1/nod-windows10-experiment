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
  learnOutputQuota,
  learnRequestQuota,
  knownRequestQuota,
  noteObservedOutput,
  noteObservedUsage,
  outputBudgetWaitMs,
  quotaPreflightError,
  remainingOutputBudget,
  retryableRateLimitWait,
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
  opts?: {
    bigExec?: boolean;
    validatingMemory?: boolean;
    bigResult?: string;
    bigThrow?: string;
    stopAfterMs?: number;
    stopAfterFirstRequest?: boolean;
    runToolNames?: string[];
    deferTools?: boolean;
    hugeExec?: boolean;
  },
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
    exec: async (command: any, options: any) => {
      const script = String(command ?? '');
      const stdout =
        opts?.hugeExec && script.includes('huge')
          ? 'x'.repeat(70_000)
          : opts?.bigExec && script.includes('big')
            ? 'x'.repeat(30_000)
            : 'ok';
      // The bash tool collects output from the onData stream, not the return
      // value; deliver the fixture payload the same way.
      if (stdout !== 'ok') options?.onData?.(Buffer.from(stdout));
      return { exitCode: 0, stdout, stderr: '' };
    },
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
      if (opts?.bigThrow === def.name) throw new Error('x'.repeat(30_000));
      if (opts?.bigResult === def.name)
        return { content: [{ type: 'text' as const, text: 'x'.repeat(30_000) }] };
      return { content: [{ type: 'text' as const, text: `${def.name} fixture result` }] };
    },
  }));
  const events: any[] = [];
  const startedAt = Date.now();
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
    ...(opts?.deferTools ? { deferTools: true } : {}),
    systemPrompt: systemPrompt(workspace, undefined, undefined),
    ownerContext: 'Owner context fixture.',
    tools: tools as any,
    workspace,
    runTool: async (_n: string, _p: unknown, run: any) => {
      opts?.runToolNames?.push(_n);
      return run();
    },
    onEvent: (event: any) => events.push(event),
    shouldStop: () =>
      opts?.stopAfterFirstRequest
        ? REQUESTS.length >= 1
        : Date.now() - startedAt > (opts?.stopAfterMs ?? Number.POSITIVE_INFINITY),
  } as any);
  return { session, executed, events, modelId };
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
  const { session, modelId } = await openSession(t, { bigExec: true });
  // Bounding above the raw passthrough bound (window/2 bytes) engages once a
  // per-minute quota is learned: a 30k result exceeds a 20k ITPM quarter-cap.
  learnRequestQuota(
    `compatible/api_key/${modelId}`,
    'Request too large for model `fixture-groq` on input tokens per minute (ITPM): Limit 20000, Requested 25000. Please reduce your message size.',
  );
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
  const retry = events.find((event) => event.type === 'retry');
  assert.ok(retry, `the retry must be visible, got: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.match(
    retry.detail ?? '',
    /rate limited, retrying in about 1s/,
    'a pacing wait must SAY it is pacing, never the generic failure text',
  );
  await session.dispose();
});

test('a user cancel interrupts the 429 pacing wait instead of hanging', async (t) => {
  responders = [groq429(), textReply('never reached')];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, events } = await openSession(t, { stopAfterFirstRequest: true });
  const started = Date.now();
  // pi converts a stopped streamFunction into an error-message turn end, so
  // the observable contract is: the pacing wait exits at once, the paced
  // retry is never sent, and the pacing event was already shown.
  await session.prompt('hi', []);
  assert.ok(Date.now() - started < 400, 'the cancel lands inside the 0.4s hint window');
  assert.equal(REQUESTS.length, 1, 'the paced retry is never sent after a cancel');
  assert.ok(
    events.some((event) => event.type === 'retry' && /rate limited/.test(event.detail ?? '')),
    'the pacing wait is announced with its real reason',
  );
  await session.dispose();
});

test('the output clamp spends the remaining minute budget, never the whole limit per request', () => {
  const key = `out-${randomUUID()}`;
  learnOutputQuota(key, 'Request too large on output tokens per minute (OTPM): Limit 1000, Requested 1232');
  const now = Date.now();
  assert.equal(remainingOutputBudget(key, now), 1000, 'fresh window: full limit');
  noteObservedOutput(key, 600, now);
  assert.equal(remainingOutputBudget(key, now), 400, 'second request this minute gets the remainder');
  noteObservedOutput(key, 395, now);
  assert.equal(remainingOutputBudget(key, now), 5, 'a near-exhausted window reports the true remainder');
  const wait = outputBudgetWaitMs(key, now);
  assert.ok(wait > 0 && wait <= 60_250, `an exhausted window waits for the next one, got ${wait}ms`);
  assert.equal(
    remainingOutputBudget(key, now + 61_000),
    1000,
    'the next minute restores the full learned limit',
  );
  assert.equal(outputBudgetWaitMs(key, now + 61_000), 0, 'no wait once the window has room');
});

test('a real provider count calibrates the conservative estimate per connection', () => {
  const key = `cal-${randomUUID()}`;
  learnRequestQuota(key, 'Request too large for model `x` on input tokens per minute (ITPM): Limit 7000, Requested 15463');
  const bigContext: any = {
    systemPrompt: 'y'.repeat(20_000),
    messages: [],
    tools: [],
  };
  // The probe clock arms at learning, so the immediate request is refused.
  const refused = quotaPreflightError(key, bigContext);
  assert.ok(refused, 'the raw conservative estimate (8,000) exceeds the learned 7,000');
  // The provider actually counted 4,000 for a request we estimated at 8,000:
  // calibrated estimates halve and the same context now fits.
  noteObservedUsage(key, 8_000, 4_000);
  assert.equal(
    quotaPreflightError(key, bigContext),
    undefined,
    'calibrated by the provider count, the same request fits the learned limit',
  );
});

test('a learned output quota clamps max_tokens so the provider stops rejecting outright', async (t) => {
  responders = [textReply('clamped')];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, modelId } = await openSession(t);
  // The live free-tier rejection: OTPM Limit 1000, Requested 1232.
  learnOutputQuota(
    `compatible/api_key/${modelId}`,
    'Request too large for model `fixture-groq` on output tokens per minute (OTPM): Limit 1000, Requested 1232. The request\'s expected output tokens exceed the enforced limit; reduce max_tokens.',
  );
  await session.prompt('hi', []);
  assert.equal(REQUESTS.length, 1);
  assert.ok(
    (REQUESTS[0].max_tokens ?? 0) <= 1000,
    `max_tokens must be clamped to the learned output limit, got ${REQUESTS[0].max_tokens}`,
  );
  await session.dispose();
});

test('a thrown tool error is bounded like a result and keeps its error flag', async (t) => {
  responders = [
    callReply('nod_tool', { name: 'memory', args: { action: 'memory_read' } }, 'c1'),
    textReply('handled the error'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed, modelId } = await openSession(t, { bigThrow: 'memory' });
  learnRequestQuota(
    `compatible/api_key/${modelId}`,
    'Request too large for model `fixture-groq` on input tokens per minute (ITPM): Limit 20000, Requested 25000. Please reduce your message size.',
  );
  await session.prompt('read my memory', []);
  assert.equal(REQUESTS.length, 2, 'gateway call + answer');
  assert.ok(executed.includes('memory'), 'the gateway dispatched to memory');
  const followUp = JSON.stringify(REQUESTS[1]);
  assert.ok(
    !followUp.includes('x'.repeat(1000)),
    'a huge thrown error message must not enter the next request raw',
  );
  assert.ok(
    followUp.includes('workspaceFile') || followUp.includes('.nod/outputs'),
    'the bounded error keeps a retrievable pointer',
  );
  await session.dispose();
});

test('a gateway-dispatched tool result is bounded like a direct call', async (t) => {
  responders = [
    callReply('nod_tool', { name: 'memory', args: { action: 'memory_read' } }, 'c1'),
    textReply('bounded answer'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const { session, executed, modelId } = await openSession(t, { bigResult: 'memory' });
  // Simulate a learned per-minute quota (20k here: small enough that a 30k
  // tool result must be bounded to a quarter of it, large enough that the
  // fixture request itself still passes preflight).
  learnRequestQuota(
    `compatible/api_key/${modelId}`,
    'Request too large for model `fixture-groq` on input tokens per minute (ITPM): Limit 20000, Requested 25000. Please reduce your message size.',
  );
  await session.prompt('read my memory', []);
  assert.equal(REQUESTS.length, 2, 'gateway call + answer');
  assert.ok(executed.includes('memory'), 'the gateway dispatched to memory');
  const followUp = JSON.stringify(REQUESTS[1]);
  assert.ok(
    !followUp.includes('x'.repeat(1000)),
    'the raw 30k tool result must not enter the next request: it is saved with a preview',
  );
  assert.ok(
    followUp.length < 30_000,
    `the follow-up request must stay small, got ${followUp.length} chars`,
  );
  await session.dispose();
});

test('a gateway-dispatched sandbox tool keeps the runTool wrapper, validation, and bounding', async (t) => {
  // The all-path proof: dispatching a sandbox tool through nod_tool must go
  // through the same runTool wrapper (approvals/permissions) and the same
  // output bounding as a direct call, and invalid target arguments must come
  // back as a corrective error rather than crashing the turn.
  responders = [
    callReply('nod_tool', { name: 'bash', args: { command: 'echo huge' } }, 'c1'),
    callReply('nod_tool', { name: 'bash', args: {} }, 'c2'),
    textReply('both handled'),
  ];
  callIndex = 0;
  REQUESTS.length = 0;
  const runToolNames: string[] = [];
  const { session, modelId } = await openSession(t, { hugeExec: true, runToolNames, deferTools: true });
  // Learn a per-minute input quota so the quarter-cap (10,000 bytes) forces
  // the 51k sandbox result into the bounded pointer path.
  learnRequestQuota(
    `compatible/api_key/${modelId}`,
    'Request too large for model `fixture-groq` on input tokens per minute (ITPM): Limit 20000, Requested 25000. Please reduce your message size.',
  );
  await session.prompt('run the command', []);
  assert.equal(REQUESTS.length, 3, 'two gateway calls + answer');
  assert.ok(runToolNames.includes('bash'), 'the gateway call passes through runTool');
  const followUp = JSON.stringify(REQUESTS[1]);
  assert.ok(
    !followUp.includes('x'.repeat(1000)),
    'a huge sandbox result through the gateway is bounded like a direct call',
  );
  assert.ok(
    followUp.includes('workspaceFile') || followUp.includes('.nod/outputs'),
    'the bounded gateway result keeps a retrievable pointer',
  );
  const afterInvalid = JSON.stringify(REQUESTS[2]);
  assert.match(
    afterInvalid,
    /Invalid arguments for tool \\"bash\\"/,
    'invalid target arguments get the same corrective validation error as a direct call',
  );
  assert.match(afterInvalid, /command/);
  assert.ok(
    !afterInvalid.includes('Cannot read properties of undefined'),
    'no opaque crash from unchecked gateway arguments',
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
