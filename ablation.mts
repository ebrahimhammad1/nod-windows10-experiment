// LOCAL payload ablation: a stub endpoint captures the exact request bodies
// Nod builds per loadout mode. Byte counts, NOT token counts; no provider.
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPiAgent } from './src/providers/pi/index.ts';
import { toolDefinitions } from './src/runtime/tools.ts';
import { systemPrompt } from './src/runtime/prompt.ts';

const bodies: any[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try { bodies.push(JSON.parse(raw)); } catch { bodies.push({ unparseable: raw.length }); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
const BASE = `http://127.0.0.1:${port}/v1`;

async function run(mode: string) {
  if (mode === 'MINIMAL') process.env.NOD_TOOL_LOADOUT = 'minimal';
  else if (mode === 'ZERO') process.env.NOD_TOOL_LOADOUT = 'zero';
  else delete process.env.NOD_TOOL_LOADOUT;
  const sessionRoot = await mkdtemp(join(tmpdir(), 'nod-abl-'));
  const workspace: any = { path: join(sessionRoot, 'ws'), instructions: 'Fixture workspace only.', exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) };
  const tools = Object.values(toolDefinitions as Record<string, any>).map((def: any) => ({
    name: def.name, description: def.description, parameters: def.parameters,
    ...(def.eager ? { eager: true } : {}), ...(def.companions?.length ? { companions: def.companions } : {}),
    execute: async () => ({ content: [{ type: 'text' as const, text: `${def.name} fixture result` }] }),
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
  const before = bodies.length;
  try {
    const session = await agent.open({
      threadId: randomUUID(), sessionId: randomUUID(), turnId: randomUUID(), runId: randomUUID(), browserId: '',
      systemPrompt: systemPrompt(workspace, undefined, undefined, false, true),
      ownerContext: 'Owner context fixture.',
      tools: tools as any, workspace,
      runTool: async (_n: string, _p: unknown, run: any) => run(),
      onEvent: () => {}, shouldStop: () => false,
    } as any);
    await session.prompt('hi', []);
    await session.dispose();
  } catch (e) { console.log(JSON.stringify({ mode, error: String(e).slice(0, 160) })); }
  await agent.dispose();
  const body = bodies[before];
  if (!body || body.unparseable) { console.log(JSON.stringify({ mode, error: 'no body captured' })); return; }
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? '');
  const messages = body.messages ?? [];
  const byRole: Record<string, number> = {};
  for (const m of messages) byRole[m.role ?? '?'] = (byRole[m.role ?? '?'] ?? 0) + bytes(m);
  console.log(JSON.stringify({
    mode,
    totalBodyBytes: Buffer.byteLength(JSON.stringify(body)),
    toolsDeclared: (body.tools ?? []).length,
    toolNames: (body.tools ?? []).map((t: any) => t.function?.name ?? t.name),
    toolSchemaBytes: bytes(body.tools ?? []),
    messageCount: messages.length,
    byRoleBytes: byRole,
    systemBytes: byRole['system'] ?? 0,
  }));
}
for (const mode of ['CURRENT', 'MINIMAL', 'ZERO']) await run(mode);
server.close();
