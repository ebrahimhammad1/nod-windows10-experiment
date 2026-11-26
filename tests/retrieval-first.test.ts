import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactHistory,
  firstInstruction,
  lastTurnHistory,
  retrievalFirstTurn,
  systemPrompt,
} from '../src/runtime/prompt.ts';

const workspace: any = {
  path: '/tmp/ws',
  instructions: 'Fixture workspace only.',
  exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
};

const message = (role: string, text: string, minutesAgo = 0): any => ({
  role,
  text,
  createdAt: Date.now() - minutesAgo * 60_000,
});

const baseContext = (overrides: Record<string, unknown> = {}): any => ({
  workspace,
  prompt: 'hi',
  history: [],
  tasks: [],
  attachments: [],
  channel: 'web',
  ...overrides,
});

test('retrievalFirstTurn accepts ordinary conversation messages without intent guessing', () => {
  assert.equal(retrievalFirstTurn(baseContext({ prompt: 'hi' })), true);
  assert.equal(retrievalFirstTurn(baseContext({ prompt: 'هاي' })), true);
  // Long, complex, referential and Arabic messages are NOT second-guessed:
  // the model decides what it needs and retrieves it.
  assert.equal(retrievalFirstTurn(baseContext({ prompt: 'قوللي اللي اتفقنا عليه' })), true);
  assert.equal(retrievalFirstTurn(baseContext({ prompt: 'x'.repeat(4000) })), true);
  assert.equal(retrievalFirstTurn(baseContext({ prompt: 'one?\ntwo?' })), true);
  assert.equal(retrievalFirstTurn(baseContext({ prompt: '```\ncode\n```' })), true);
});

test('retrievalFirstTurn rejects task, background, proactive, scheduled and continuation turns', () => {
  assert.equal(retrievalFirstTurn(baseContext({ taskContext: { id: 't1' } })), false);
  assert.equal(retrievalFirstTurn(baseContext({ background: true })), false);
  assert.equal(retrievalFirstTurn(baseContext({ proactivity: { issues: [], sources: [] } })), false);
  assert.equal(retrievalFirstTurn(baseContext({ scheduleCache: 'short' })), false);
  assert.equal(
    retrievalFirstTurn(
      baseContext({ attachments: [{ path: '/tmp/ws/a.png', mimeType: 'image/png' }] }),
    ),
    false,
  );
  assert.equal(retrievalFirstTurn(baseContext({ credentialRequests: [{ id: 'c1' }] })), false);
  assert.equal(retrievalFirstTurn(baseContext({ previousFailure: 'boom' })), false);
  assert.equal(retrievalFirstTurn(baseContext({ withdrawnRequest: 'stop' })), false);
});

const longHistory = () => [
  message(
    'user',
    'long trip discussion covering hotels budgets and family '.repeat(10) +
      'FINAL DECISION: نسافر يوم الخميس مش الجمعة',
    50,
  ),
  message('assistant', 'تمام، سجلت القرار. '.repeat(10), 49),
  ...Array.from({ length: 8 }, (_, i) =>
    message(i % 2 === 0 ? 'user' : 'assistant', `recent exchange line ${i} `.repeat(12), 10 - i),
  ),
];

test('a retrieval-first request injects only the recent window plus a retrieval locator', () => {
  const history = longHistory();
  const recent = compactHistory(history);
  const light = firstInstruction(
    baseContext({ history: recent, retrievalFirst: true }),
    false,
    new Set(),
  );
  assert.match(light, /notInjected/);
  assert.match(light, /history_search \{query,around\} reads complete original messages/);
  assert.match(light, /docs_search reads Nod guides/);
  assert.match(light, /memory_find reads saved facts/);
  assert.match(light, /task list reads open work/);
  // No digest or summary of dropped messages anywhere.
  assert.ok(!light.includes('earlierConversationDigest'));
  assert.ok(!light.includes('digest'));
  // The tail decision is NOT injected; it is retrievable via history_search.
  assert.ok(!light.includes('FINAL DECISION'));
});

test('a retrieval-first request sends no task data; tasks load through the task tool', () => {
  const tasks: any = [
    {
      id: 't1',
      title: 'Book the trip',
      status: 'waiting',
      now: 'long progress text '.repeat(50),
      question: 'which hotel?',
      result: '',
    },
    { id: 't2', title: 'Old task', status: 'done', closedAt: new Date().toISOString(), result: 'r' },
  ];
  const light = firstInstruction(baseContext({ tasks, retrievalFirst: true }), false, new Set());
  assert.ok(!light.includes('Book the trip'), 'no per-task locator lines');
  assert.ok(!light.includes('long progress text'));
  assert.ok(!light.includes('which hotel?'));
  assert.match(light, /"taskLedger":\[\]/);
  assert.match(light, /task list reads open work/, 'the navigation pointer remains');
  const full = firstInstruction(baseContext({ tasks }), false, new Set());
  assert.match(full, /long progress text/);
});

test('the retrieval-first recent window keeps only the last exchange plus the current message', () => {
  const history = [
    message('user', 'old question one', 40),
    message('assistant', 'old answer one', 39),
    message('user', 'previous question two', 30),
    message('assistant', 'previous answer two', 29),
    message('user', 'current message three', 20),
  ];
  const windowed = lastTurnHistory(history);
  assert.deepEqual(
    windowed.map((item) => item.text),
    ['previous question two', 'previous answer two', 'current message three'],
  );
  const prompt = firstInstruction(
    baseContext({ history: windowed, retrievalFirst: true }),
    false,
    new Set(),
  );
  assert.ok(!prompt.includes('old question one'), 'older exchanges are not injected');
  assert.match(prompt, /previous question two/);
  // First conversation turn: no prior exchange exists, nothing is dropped.
  const first = lastTurnHistory([message('user', 'current message three', 20)]);
  assert.equal(first.length, 1);
});

test('the system prompt guide describes retrieval, not a digest', () => {
  const prompt = systemPrompt(workspace, undefined, undefined, false, false);
  assert.match(prompt, /notInjected/);
  assert.match(prompt, /history_search reads complete earlier messages/);
  assert.ok(!prompt.includes('earlierConversationDigest'));
});

test('a retrieval-first request is much smaller than the full-history request', () => {
  const history = longHistory();
  const full = firstInstruction(baseContext({ history }), false, new Set());
  const light = firstInstruction(
    baseContext({ history: compactHistory(history), retrievalFirst: true }),
    false,
    new Set(),
  );
  const fullBytes = Buffer.byteLength(full);
  const lightBytes = Buffer.byteLength(light);
  assert.ok(
    lightBytes < fullBytes * 0.6,
    `retrieval-first (${lightBytes}) should be well under full (${fullBytes})`,
  );
});
