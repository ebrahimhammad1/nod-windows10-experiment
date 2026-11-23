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

// Execute the real startup wiring, not a synthetic copy of its condition.
test('packaged Win10 keeps pinned runtime resolver without enabling app updates', async () => {
  const { runInNewContext } = await import('node:vm');
  const { createUpdateSource } = await import('../main/updates.mjs');
  const main = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  const start = main.indexOf('      const { nodBuild: compatibilityBuild }');
  const stop = main.indexOf("      nativeTheme.on('updated', publishPreferences);", start);
  assert.ok(start > 0 && stop > start);
  const wiring = main.slice(start, stop);
  const guest = { sha256: '8'.repeat(64), bytes: 1332119078 };
  for (const [platform, packaged, profile, experimental, expectedSource, expectedUpdater] of [
    ['win32', true, false, true, true, false],
    ['win32', true, false, false, true, true],
    ['darwin', true, false, false, true, true],
    ['win32', false, false, true, false, false],
    ['win32', true, true, true, false, false],
    ['linux', true, false, true, false, false],
  ]) {
    let sources = 0, updaters = 0, timers = 0, network = 0;
    const fixtureProcess = { platform };
    Object.defineProperty(fixtureProcess, 'getSystemVersion', {
      get() { throw Error('Windows10 fixture must not consult an OS admission gate'); },
    });
    const context = {
      app: { isPackaged: packaged, getVersion: () => '0.9.4' },
      process: fixtureProcess, testInstall: profile, desktopRoot: '/fixture', join: (...x) => x.join('/'),
      readFile: async () => JSON.stringify({ nodBuild: { experimentalWindows10: experimental } }),
      createUpdateSource: (options) => {
        sources++;
        return createUpdateSource({ ...options, os: platform, arch: 'x64',
          fetch: async () => { network++; throw Error('Runtime resolution must not fetch app update metadata'); } });
      },
      createDesktopUpdater: () => { updaters++; return {}; },
      startDesktopUpdateChecks: () => { timers++; },
      clearInstalledWindowsUpdates: async () => {}, windowsUpdates: '/fixture/updates',
      autoUpdater: { on() {} }, restartForUpdate() {}, reportUpdateStatus() {},
      powerMonitor: {}, macInstallerBusy: false, checkForUpdates() {}, updateEvent() {},
    };
    const sandbox = { ...context, updateSource: undefined, updates: undefined, stopUpdateChecks: undefined };
    sources = updaters = timers = 0;
    const result = await runInNewContext('(async () => {' + wiring + '; return {updateSource, updates}; })()', sandbox);
    assert.equal(sources, Number(expectedSource));
    assert.equal(updaters, Number(expectedUpdater));
    assert.equal(timers, Number(expectedUpdater));
    if (expectedSource && platform === 'win32') {
      assert.equal(await result.updateSource.runtimeDownloadUrl({ releaseTag: 'nod-v0.9.4', guest }),
        'https://github.com/n8n-io/nod/releases/download/nod-v0.9.4/nod-Runtime-win32-x64.tar.gz');
    }
    assert.equal(network, 0);
  }
});
