// LOCAL zero-protocol loop repro: stub endpoint answers with a canned tool
// command first, then a plain reply. Logs what the memory fixture receives.
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPiAgent } from './src/providers/pi/index.ts';
import { toolDefinitions } from './src/runtime/tools.ts';
import { systemPrompt } from './src/runtime/prompt.ts';

process.env.NOD_TOOL_LOADOUT = 'zero';
let calls = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    calls++;
    const tail = raw.slice(-600);
    const gotValidationError = tail.includes('memory_learn args must be');
    const gotSaved = /"role":"user","content":\[\{"type":"text","text":"Tool result[^"]*Saved to memory/.test(tail);
    const reply = gotSaved
      ? 'Saved it - Milo.'
      : gotValidationError
        ? '{"tool":"memory","input":{"action":"memory_learn","args":{}}}'
        : '{"tool":"memory","input":{"action":"memory_learn","args":{"note":"My cat is Milo"}}}';
    console.error('STUB reply:', reply.slice(0, 90));
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(server.address() as any).port}/v1`;
const sessionRoot = await mkdtemp(join(tmpdir(), 'nod-loop-'));
const memoryFile = join(sessionRoot, 'memory-store.json');
const memoryActions = ['memory_find', 'memory_read', 'memory_learn', 'memory_control', 'memory_forget'];
const workspace: any = { path: join(sessionRoot, 'ws'), instructions: 'Fixture workspace only.', exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) };
const tools = Object.values(toolDefinitions as Record<string, any>).map((def: any) => ({
  name: def.name, description: def.description, parameters: def.parameters,
  execute: async (args: any, _opts: any) => {
    if (def.name !== 'memory') return { content: [{ type: 'text' as const, text: `${def.name} fixture result` }] };
    console.error('FIXTURE memory received:', JSON.stringify(args)?.slice(0, 300));
    const action = args?.action;
    if (!memoryActions.includes(action))
      return { content: [{ type: 'text' as const, text: `Error: memory needs a valid "action" (${memoryActions.join(', ')}); got ${JSON.stringify(action ?? null)}.` }] };
      if (action === 'memory_learn' && args?.args !== undefined) {
        const inner = args.args as Record<string, unknown>;
        const keys = Object.keys(inner ?? {});
        if (keys.length && !(keys.length === 1 && Array.isArray(inner.messages)))
          return { content: [{ type: 'text' as const, text: `Error: memory_learn args must be {messages?: [message IDs]} - it reads the current owner message itself; got keys ${JSON.stringify(keys)}.` }] };
      }
    const store = JSON.parse(await readFile(memoryFile, 'utf8').catch(() => '{"notes":[]}'));
    if (action === 'memory_learn') {
      store.notes.push({ at: new Date().toISOString(), args });
      await writeFile(memoryFile, JSON.stringify(store));
      return { content: [{ type: 'text' as const, text: 'Saved to memory.' }] };
    }
    return { content: [{ type: 'text' as const, text: 'ok' }] };
  },
}));
const agent = createPiAgent({
  provider: 'compatible', sessionRoot,
  resolve: async () => ({
    provider: 'compatible', method: 'api_key', effort: 'off',
    read: async () => ({ type: 'endpoint', url: BASE, key: 'fixture' }),
    definition: {
      choice: { id: 'fixture-model', name: 'fixture-model', efforts: ['off'], images: false, contextWindow: 131_072 },
      spec: { id: 'fixture-model', name: 'fixture-model', provider: 'compatible', api: 'openai-completions', baseUrl: BASE, reasoning: false, input: ['text'], contextWindow: 131_072, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' } },
    },
  }) as any,
});
try {
  const session = await agent.open({
    threadId: randomUUID(), sessionId: randomUUID(), turnId: randomUUID(), runId: randomUUID(), browserId: '',
    systemPrompt: systemPrompt(workspace, undefined, undefined, false, true),
    ownerContext: 'Owner context fixture.',
    tools: tools as any, workspace,
    runTool: async (_n: string, _p: unknown, run: any) => run(),
    onEvent: () => {}, shouldStop: () => false,
  } as any);
  await session.prompt('Remember that my cat is Milo.', []);
  await session.dispose();
} catch (e) { console.error('THREW', String((e as any)?.stack ?? e).slice(0, 500)); }
await agent.dispose();
server.close();
console.error('STORE:', await readFile(memoryFile, 'utf8').catch(() => 'missing'));
