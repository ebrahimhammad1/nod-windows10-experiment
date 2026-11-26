const { systemPrompt } = await import('./src/runtime/prompt.ts');
const workspace: any = { path: '/tmp/ws', instructions: 'Fixture workspace only.', exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
const p = systemPrompt(workspace, undefined, undefined, false, true);
console.log('TOTAL', Buffer.byteLength(p), 'lines', p.split('\n').length);
p.split('\n').forEach((line: string, i: number) => {
  console.log(String(i + 1).padStart(4), String(Buffer.byteLength(line)).padStart(6), line.slice(0, 110));
});
