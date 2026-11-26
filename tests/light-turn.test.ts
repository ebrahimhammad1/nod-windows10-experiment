import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactHistory,
  firstInstruction,
  lightTurn,
  rollingHistory,
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

test('lightTurn accepts a short structurally simple conversation message', () => {
  assert.equal(lightTurn(baseContext({ prompt: 'hi' })), true);
  assert.equal(lightTurn(baseContext({ prompt: 'thanks, sounds good' })), true);
});

test('lightTurn rejects task, background, proactive and scheduled work', () => {
  assert.equal(lightTurn(baseContext({ taskContext: { id: 't1' } })), false);
  assert.equal(lightTurn(baseContext({ background: true })), false);
  assert.equal(lightTurn(baseContext({ proactivity: { issues: [], sources: [] } })), false);
  assert.equal(lightTurn(baseContext({ scheduleCache: 'short' })), false);
});

test('lightTurn rejects attachments, sign-in forms, failures and rich or empty messages', () => {
  assert.equal(
    lightTurn(baseContext({ attachments: [{ path: '/tmp/ws/a.png', mimeType: 'image/png' }] })),
    false,
  );
  assert.equal(lightTurn(baseContext({ credentialRequests: [{ id: 'c1' }] })), false);
  assert.equal(lightTurn(baseContext({ previousFailure: 'boom' })), false);
  assert.equal(lightTurn(baseContext({ prompt: '```\ncode\n```' })), false);
  assert.equal(lightTurn(baseContext({ prompt: 'one?\ntwo?' })), false);
  assert.equal(lightTurn(baseContext({ prompt: 'x'.repeat(1201) })), false);
  assert.equal(lightTurn(baseContext({ prompt: '   ' })), false);
});

test('rollingHistory keeps the compact recent window and digests the dropped rest', () => {
  const history = [
    message('user', 'decision: we go with the cheap plan, cancel the other one', 50),
    message('assistant', 'Done, cancelled the second plan and kept the cheap one.', 49),
    ...Array.from({ length: 8 }, (_, i) =>
      message(i % 2 === 0 ? 'user' : 'assistant', `recent exchange line ${i} `.repeat(12), 10 - i),
    ),
  ];
  const rolled = rollingHistory(history);
  assert.deepEqual(rolled.recent, compactHistory(history));
  assert.ok(rolled.recent.length < history.length);
  assert.match(rolled.digest, /owner: decision: we go with the cheap plan/);
  assert.match(rolled.digest, /^owner:|^assistant:/);
  assert.ok(rolled.digest.length <= 1700);
});

test('rollingHistory digest keeps the newest dropped lines when over budget and counts omissions', () => {
  const history = Array.from({ length: 60 }, (_, i) =>
    message(i % 2 === 0 ? 'user' : 'assistant', `older message number ${i} `.repeat(10), 100 - i),
  );
  const rolled = rollingHistory(history, 800);
  assert.ok(rolled.digest.length <= 800);
  assert.ok(rolled.omitted > 0);
  // Newest dropped line survives; oldest is omitted.
  const lastDropped = 60 - rolled.recent.length - 1;
  assert.match(rolled.digest, new RegExp(`older message number ${lastDropped} `));
});

test('rollingHistory returns no digest when nothing is dropped', () => {
  const rolled = rollingHistory([message('user', 'hi', 1)]);
  assert.equal(rolled.digest, '');
  assert.equal(rolled.omitted, 0);
});

test('a light-turn request carries the digest as data and stays much smaller than the full request', () => {
  const history = Array.from({ length: 30 }, (_, i) =>
    message(
      i % 2 === 0 ? 'user' : 'assistant',
      'tell me what the supplier said about the shipment and the invoice totals '.repeat(
        i % 2 === 0 ? 1 : 3,
      ),
      60 - i,
    ),
  );
  const rolled = rollingHistory(history);
  const full = firstInstruction(baseContext({ history }), false, new Set());
  const light = firstInstruction(
    baseContext({
      history: rolled.recent,
      historyDigest: rolled.digest,
      historyDigestOmitted: rolled.omitted,
    }),
    false,
    new Set(),
  );
  assert.match(light, /earlier conversation digest/);
  assert.match(light, /owner: /);
  const prompt = systemPrompt(workspace, undefined, undefined, false, false);
  assert.match(prompt, /earlierConversationDigest/);
  assert.match(prompt, /reads digest lines whole/);
  const fullBytes = Buffer.byteLength(full);
  const lightBytes = Buffer.byteLength(light);
  assert.ok(
    lightBytes < fullBytes * 0.6,
    `light (${lightBytes}) should be well under full (${fullBytes})`,
  );
});
