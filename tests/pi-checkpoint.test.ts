import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  closeInterruptedCalls,
  completeAssistantMessage,
  openLocalSession,
} from '../src/providers/pi/checkpoint.ts';

const assistant = (content: unknown[], stopReason = 'toolUse') => ({
  role: 'assistant' as const,
  api: 'openai-completions',
  provider: 'fixture',
  model: 'fixture-model',
  timestamp: Date.now(),
  responseId: 'fixture-response',
  stopReason,
  content,
});

const toolCall = (id: string) => ({
  type: 'toolCall' as const,
  id,
  name: 'fixture_tool',
  arguments: { id },
});

const toolResult = (id: string) => ({
  role: 'toolResult' as const,
  toolCallId: id,
  toolName: 'fixture_tool',
  content: [{ type: 'text' as const, text: 'done' }],
  details: {},
  isError: false,
  timestamp: Date.now(),
});

const toolResults = (manager: ReturnType<typeof openLocalSession>) =>
  manager.buildSessionContext().messages.filter((message) => message.role === 'toolResult');

test('an interrupted tool call is closed as an error result, not replayed, and survives reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-checkpoint-'));
  try {
    const crashed = openLocalSession(directory);
    crashed.appendMessage(assistant([toolCall('answered'), toolCall('dangling')]) as never);
    crashed.appendMessage(toolResult('answered') as never);
    closeInterruptedCalls(crashed);

    let results = toolResults(crashed);
    assert.equal(results.length, 2, 'exactly the dangling call is closed');
    const closed = results.find((message) => message.toolCallId === 'dangling');
    assert.equal(closed?.isError, true);
    assert.match(
      JSON.stringify(closed?.content),
      /interrupted.*outcome is unknown/i,
      'the closure warns against blind re-execution',
    );
    assert.equal(
      results.find((message) => message.toolCallId === 'answered')?.isError,
      false,
      'the answered call keeps its real result',
    );

    // Persistence across a process restart: a reopened session sees the closure
    // and closing again adds nothing (no duplicate results on the next turn).
    const reopened = openLocalSession(directory);
    closeInterruptedCalls(reopened);
    results = toolResults(reopened);
    assert.equal(results.length, 2, 'reopen persists the closure; closing twice adds nothing');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborted or errored assistant turns are left untouched by interruption closing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-checkpoint-'));
  try {
    for (const stopReason of ['aborted', 'error']) {
      const manager = openLocalSession(directory);
      manager.appendMessage(assistant([toolCall(`pending-${stopReason}`)], stopReason) as never);
      closeInterruptedCalls(manager);
      assert.equal(
        toolResults(manager).length,
        0,
        `${stopReason} turns are already terminated; no synthetic result is appended`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('completeAssistantMessage sanitizes malformed streamed content without dropping valid parts', () => {
  const malformed = assistant([
    { type: 'text' },
    { type: 'thinking', thinking: 42 },
    { type: 'text', text: 'kept' },
    null,
  ]);
  const repaired = completeAssistantMessage(malformed as never);
  assert.deepEqual(
    repaired.content.map((part) => (part as { type: string; text?: string }).type),
    ['text', 'text'],
  );
  assert.equal((repaired.content[0] as { text: string }).text, '');
  assert.equal((repaired.content[1] as { text: string }).text, 'kept');

  const redacted = completeAssistantMessage(
    assistant([
      { type: 'thinking', thinking: 42, redacted: true, thinkingSignature: 'sig' },
    ]) as never,
  );
  assert.equal((redacted.content[0] as { thinking: string }).thinking, '[Reasoning redacted]');

  const valid = assistant([{ type: 'text', text: 'untouched' }]);
  assert.equal(completeAssistantMessage(valid as never), valid, 'valid messages pass through');
});
