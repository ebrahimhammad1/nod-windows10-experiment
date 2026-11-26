// Live bounded benchmark against the user's existing Groq connection.
// Key is read from the vault-copied file at runtime (GROQ_KEY_FILE); it is
// never printed or logged. Requests are spaced past the 60s ITPM window so
// per-minute quota does not contaminate per-request acceptance/timing.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAgent } from './src/providers/pi/index.ts';
import { toolDefinitions } from './src/runtime/tools.ts';
import { systemPrompt } from './src/runtime/prompt.ts';
import { learnRequestQuota } from './src/providers/pi/request-quota.ts';

const key = (await readFile(process.env.GROQ_KEY_FILE!, 'utf8')).trim();
const BASE = 'https://api.groq.com/openai/v1';
const MODEL = 'qwen/qwen3.8-27b';

// Capture real provider traffic: status, usage, wall ms and true TTFT
// (time to first SSE byte). The stream is read through and rebuilt so the
// caller still gets a normal Response.
const realFetch = globalThis.fetch;
const captures: any[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  const started = performance.now();
  const res = await realFetch(url, init);
  if (typeof init?.body !== 'string' || !init.body.includes('"messages"')) return res;
  const chunks: Uint8Array[] = [];
  let ttftMs: number | undefined;
  let promptTokens: number | undefined, completionTokens: number | undefined;
  let errorText: string | undefined;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (ttftMs === undefined && value?.length) ttftMs = Math.round(performance.now() - started);
        if (done) break;
        if (value) chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const usageMatches = [...text.matchAll(/"usage":(\{[^}]*\})/g)];
    if (usageMatches.length) {
      const u = JSON.parse(usageMatches.at(-1)![1]);
      promptTokens = u.prompt_tokens;
      completionTokens = u.completion_tokens;
    }
    if (res.status !== 200) errorText = text.slice(0, 400);
    captures.push({
      status: res.status,
      wallMs: Math.round(performance.now() - started),
      ttftMs,
      promptTokens,
      completionTokens,
      ...(errorText ? { error: errorText } : {}),
    });
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(text, { status: res.status, statusText: res.statusText, headers });
  } catch (e) {
    captures.push({ status: res.status, wallMs: Math.round(performance.now() - started), error: String(e) });
    return res;
  }
};

async function run(mode: 'CURRENT' | 'MINIMAL', promptText: string) {
  if (mode === 'MINIMAL') process.env.NOD_TOOL_LOADOUT = 'minimal';
  else delete process.env.NOD_TOOL_LOADOUT;
  const sessionRoot = await mkdtemp(join(tmpdir(), 'nod-live-'));
  const workspace: any = {
    path: join(sessionRoot, 'ws'),
    instructions: 'Fixture workspace only.',
    exec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
  };
  const tools = Object.values(toolDefinitions as Record<string, any>).map((def: any) => ({
    name: def.name, description: def.description, parameters: def.parameters,
    ...(def.eager ? { eager: true } : {}),
    ...(def.companions?.length ? { companions: def.companions } : {}),
    execute: async () => ({ content: [{ type: 'text' as const, text: `${def.name} fixture result` }] }),
  }));
  const agent = createPiAgent({
    provider: 'compatible',
    sessionRoot,
    resolve: async () => ({
      provider: 'compatible', method: 'api_key', effort: 'off',
      read: async () => ({ type: 'endpoint', url: BASE, key }),
      definition: {
        choice: { id: MODEL, name: MODEL, efforts: ['off'], images: false, contextWindow: 131_072 },
        spec: {
          id: MODEL, name: MODEL, provider: 'compatible', api: 'openai-completions',
          baseUrl: BASE, reasoning: false, input: ['text'], contextWindow: 131_072, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        },
      },
    }) as any,
  });
  const before = captures.length;
  const t0 = performance.now();
  let outcome = 'answered';
  try {
    const session = await agent.open({
      threadId: randomUUID(), sessionId: randomUUID(), turnId: randomUUID(), runId: randomUUID(), browserId: '',
      systemPrompt: systemPrompt(workspace, undefined, undefined, false, true), // compact variant (existing feature)
      ownerContext: 'Owner context fixture.',
      tools: tools as any, workspace,
      runTool: async (_n: string, _p: unknown, run: any) => run(),
      onEvent: () => {}, shouldStop: () => false,
    } as any);
    // NOD_BENCH_LEARN=7000 seeds the quota a long-lived app would already
    // have learned from an earlier rejection, so a fresh bench process
    // exercises the quota-aware paths instead of re-paying the first 413.
    if (process.env.NOD_BENCH_LEARN)
      learnRequestQuota(
        `compatible/api_key/${MODEL}`,
        `Request too large for model \`${MODEL}\` on input tokens per minute (ITPM): Limit ${process.env.NOD_BENCH_LEARN}, Requested 99999. Please reduce your message size.`,
      );
    await session.prompt(promptText, []);
    await session.dispose();
  } catch (e) {
    outcome = `threw: ${String(e).slice(0, 200)}`;
  }
  const wallMs = Math.round(performance.now() - t0);
  await agent.dispose();
  console.log(JSON.stringify({ mode, prompt: promptText.slice(0, 30), wallMs, outcome, calls: captures.slice(before) }));
}

const mode1 = (process.argv[2] ?? 'MINIMAL') as 'CURRENT' | 'MINIMAL';
await run(mode1, process.argv[3] ?? 'hi');
