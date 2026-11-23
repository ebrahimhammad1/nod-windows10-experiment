// Runs only in a disposable Windows CI runner against the extracted shipped engine.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const application = resolve(process.argv[2]);
const engine = join(application, 'resources/engine');
const executable = join(application, 'nod.exe');
const temporary = await mkdtemp(join(tmpdir(), 'nod-engine-smoke-'));
const environment = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  ESBUILD_WORKER_THREADS: '0',
  NODE_ENV: 'production',
  NOD_ANALYTICS_ENABLED: 'false',
  NOD_DATA_ROOT: temporary,
  NOD_VAULT_KEY: randomBytes(32).toString('base64'),
};
delete environment.ESBUILD_BINARY_PATH;
try {
  // The exact same entry used by utilityProcess.fork() in startEngine, with only
  // server/index.ts replaced by a synthetic TS module. No real DB, WSL or keys.
  const fixture = join(temporary, 'engine-fixture.ts');
  await writeFile(
    fixture,
    'const answer: number = 6 * 7; console.log("NOD_ENGINE_TS_OK=" + answer);',
  );
  const hook = join(temporary, 'engine-hook.mjs');
  await writeFile(
    hook,
    `export async function resolve(specifier, context, next) {\nif (context.parentURL === ${JSON.stringify(pathToFileURL(join(engine, 'desktop/main/engine.mjs')).href)} && specifier === '../../src/server/index.ts') return {url:${JSON.stringify(pathToFileURL(fixture).href)},shortCircuit:true};\nreturn next(specifier,context);\n}`,
  );
  const launch = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hook).href)}, import.meta.url); await import(${JSON.stringify(pathToFileURL(join(engine, 'desktop/main/engine.mjs')).href)});`;
  const run = (script) => {
    const result = spawnSync(executable, ['--input-type=module', '-e', script], {
      cwd: engine,
      env: environment,
      encoding: 'utf8',
      timeout: 180000,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    return result.stdout;
  };
  assert.match(run(launch), /NOD_ENGINE_TS_OK=42/);
  // Real production dependency graph, not just a synthetic esbuild invocation.
  const imports = `import assert from 'node:assert/strict';
import {register} from 'tsx/esm/api';
const {transformSync} = await import('esbuild');
assert.match(transformSync('const x: number = 42', {loader:'ts'}).code, /42/);
register();
await import('./src/server/composition.ts');
const {pool} = await import('./src/server/db.ts');
await pool.end();
const sharp=(await import('sharp')).default;
assert.equal((await sharp({create:{width:2,height:2,channels:4,background:'#f00'}}).png().toBuffer()).length > 0,true);
const {createCanvas}=await import('@napi-rs/canvas'); assert.equal(createCanvas(2,2).width,2);
console.log('NOD_WINDOWS_ENGINE_IMPORTS_OK');`;
  assert.match(run(imports), /NOD_WINDOWS_ENGINE_IMPORTS_OK/);
  console.log('Windows packaged engine smoke passed. Not a Windows10/WSL end-to-end test.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
