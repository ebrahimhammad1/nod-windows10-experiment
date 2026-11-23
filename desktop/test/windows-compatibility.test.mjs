// Experimental compatibility tests, added November 23, 2026.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { windowsCompatibilityBuild } from '../scripts/windows-compatibility.mjs';

test('normal builds retain the upstream installer policy', () => {
  for (const value of [undefined, '', 'false']) {
    assert.deepEqual(windowsCompatibilityBuild({ NOD_EXPERIMENTAL_WINDOWS10: value }), []);
  }
});
test('experimental admission is explicit and cannot be an official release', () => {
  assert.deepEqual(windowsCompatibilityBuild({ NOD_EXPERIMENTAL_WINDOWS10: 'true' }), [
    '/DNOD_EXPERIMENTAL_WINDOWS10',
  ]);
  assert.throws(() => windowsCompatibilityBuild({ NOD_EXPERIMENTAL_WINDOWS10: '1' }));
  assert.throws(() =>
    windowsCompatibilityBuild({
      NOD_EXPERIMENTAL_WINDOWS10: 'true',
      NOD_RELEASE_BUILD: 'true',
    }),
  );
});
test('installer preserves architecture and build floors and defaults to cancel', async () => {
  const script = await readFile(
    new URL('../scripts/windows-installer.nsi', import.meta.url),
    'utf8',
  );
  assert.ok(script.includes('${IsNativeAMD64}'));
  assert.ok(script.includes('!ifdef NOD_EXPERIMENTAL_WINDOWS10'));
  assert.ok(script.includes('${If} $0 < 19045'));
  assert.ok(script.includes('${If} $0 < 22000'));
  assert.ok(script.includes('/SD IDCANCEL IDOK experimental_continue'));
  assert.ok(script.includes('WSL 2 is still required'));
});
test('build propagates opt-in and packaged app blocks upstream automatic updates', async () => {
  const build = await readFile(new URL('../scripts/build-windows.mjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes('...compatibilityFlags'));
  assert.ok(build.includes('experimentalWindows10: compatibilityFlags.length > 0'));
  assert.ok(main.includes('!compatibilityBuild?.experimentalWindows10'));
});

test('experiment isolates installation and profile and keeps official downloader strict', async () => {
  const script = await readFile(new URL('../scripts/windows-installer.nsi', import.meta.url), 'utf8');
  const main = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  const downloader = await readFile(new URL('../../deployment/n8n/install.ps1', import.meta.url), 'utf8');
  assert.ok(script.includes('NOD_INSTALL_KEY "nod-win10-experiment"'));
  assert.ok(script.includes('NOD_PUBLISHER "Unofficial source build"'));
  assert.ok(script.includes('!ifndef NOD_EXPERIMENTAL_WINDOWS10'));
  assert.ok(main.includes("'nod-win10-experiment'"));
  assert.ok(main.includes("appName !== 'Nod Windows 10 Experiment'"));
  assert.ok(downloader.includes("$env:NOD_EXPERIMENTAL_WINDOWS10 -eq 'true'"));
  assert.ok(downloader.includes("CurrentBuildNumber -lt 22000"));
  assert.ok(downloader.includes("$signature.Status -ne 'Valid'"));
});
