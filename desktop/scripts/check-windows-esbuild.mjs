import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Exercise the actual packaged esbuild loader's Windows branch without spawning
// a foreign executable. Native execution is separately required on Windows CI.
export async function checkWindowsEsbuild(engine) {
  const require = createRequire(resolve(engine, 'package.json'));
  const main = require.resolve('esbuild');
  const metadata = JSON.parse(await readFile(require.resolve('esbuild/package.json'), 'utf8'));
  const binary = require.resolve('@esbuild/win32-x64/esbuild.exe');
  const native = JSON.parse(
    await readFile(require.resolve('@esbuild/win32-x64/package.json'), 'utf8'),
  );
  assert.equal(native.version, metadata.version);
  assert.deepEqual(native.os, ['win32']);
  assert.deepEqual(native.cpu, ['x64']);
  const bytes = await readFile(binary);
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.subarray(pe, pe + 4).toString(), 'PE\0\0');
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
  let code = await readFile(main, 'utf8');
  code += '\nmodule.exports.__probeWindowsBinary = generateBinPath;';
  const localRequire = createRequire(main);
  const exports = {};
  const sandbox = {
    module: { exports },
    exports,
    __filename: main,
    __dirname: dirname(main),
    process: { ...process, platform: 'win32', arch: 'x64', env: { ESBUILD_WORKER_THREADS: '0' } },
    require: Object.assign(
      (name) =>
        name === 'os' || name === 'node:os'
          ? { ...localRequire(name), arch: () => 'x64', endianness: () => 'LE' }
          : localRequire(name),
      { resolve: localRequire.resolve },
    ),
    Buffer,
    Uint8Array,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(code, sandbox, { filename: main });
  const result = sandbox.module.exports.__probeWindowsBinary();
  assert.equal(result.binPath, binary);
  assert.equal(result.isWASM, false);
  return { version: native.version, binary, bytes: bytes.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await checkWindowsEsbuild(resolve(process.argv[2]))));
}
