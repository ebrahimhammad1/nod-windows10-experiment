/**
 * Unit tests for the zero-definition protocol (NOD_TOOL_LOADOUT=zero):
 *   - the parser accepts exactly one-JSON-object replies (fences tolerated)
 *     and never mistakes prose, partial JSON or non-object input for a call;
 *   - the local catalog ranks deferred tools by the query, caps at five
 *     entries, and never lists direct-exposure tools.
 * No network: pure functions against the REAL module.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { zeroToolCatalog, zeroToolCommand } from '../src/providers/pi/index.ts';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

test('a bare one-object reply is a command', () => {
  assert.deepEqual(zeroToolCommand('{"tool":"memory_search","input":{"query":"cat"}}'), {
    tool: 'memory_search',
    input: { query: 'cat' },
  });
});

test('a fenced json reply is a command', () => {
  assert.deepEqual(zeroToolCommand('```json\n{"tool":"memory_read"}\n```'), {
    tool: 'memory_read',
    input: undefined,
  });
});

test('prose, mixed text and partial JSON are never commands', () => {
  assert.equal(zeroToolCommand('Sure! Here is the JSON: {"tool":"x"}'), undefined);
  assert.equal(zeroToolCommand('{"tool":"x"} hope that helps'), undefined);
  assert.equal(zeroToolCommand('{"tool": "x", '), undefined);
  assert.equal(zeroToolCommand('hello'), undefined);
  assert.equal(zeroToolCommand(''), undefined);
});

test('non-string tool and non-object input are rejected', () => {
  assert.equal(zeroToolCommand('{"tool":42}'), undefined);
  assert.equal(zeroToolCommand('{"tool":"x","input":[1,2]}'), undefined);
  assert.equal(zeroToolCommand('{"tool":"x","input":null}'), undefined);
  assert.equal(zeroToolCommand('{}'), undefined);
});

const tool = (name: string, exposure: 'direct' | 'deferred', description = ''): ToolDefinition =>
  ({ name, label: name, description, parameters: { type: 'object' }, exposure }) as unknown as ToolDefinition;

test('the catalog ranks by query, caps at five and hides direct tools', () => {
  const tools = [
    tool('memory_read', 'deferred', 'Read a memory file by path.'),
    tool('memory_search', 'deferred', 'Search memory files for a phrase.'),
    tool('browser', 'deferred', 'Drive the web browser.'),
    tool('send_message', 'direct', 'Send a message.'),
    tool('memory_write', 'deferred', 'Write a memory file.'),
    tool('calendar_list', 'deferred', 'List calendar events.'),
    tool('mail_read', 'deferred', 'Read mail.'),
  ];
  const result = zeroToolCatalog(tools, 'memory');
  assert.deepEqual(
    result.tools.map((entry) => entry.name).sort(),
    ['memory_read', 'memory_search', 'memory_write'],
  );
  assert.ok(!result.tools.some((entry) => entry.name === 'send_message'));
  // Definitions stay local: discovery never returns a schema, only names.
  assert.ok(result.tools.every((entry) => !('parameters' in entry)));
  assert.ok(
    result.tools.every((entry) =>
      (entry as { arguments?: string[] }).arguments?.every((arg) => !arg.includes(':')),
    ),
  );
  const capped = zeroToolCatalog(
    Array.from({ length: 12 }, (_, index) => tool(`deferred_${index}`, 'deferred', 'shared word')),
    'shared',
  );
  assert.equal(capped.tools.length, 5);
});
