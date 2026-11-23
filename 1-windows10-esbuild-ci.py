#!/usr/bin/env python3
"""Single-run unofficial Windows 10 source build. No paid services or PC execution."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request

BASE = '2118c357299fe550bd693b8fdfd7c1b4fa580c7e'
PATCH_HASH = '6664f26973ec1a367c8a68885b01fa05211a3af22addf317ec53c2af951ce549'
RUNTIME_HASH = '850d808d0d64ad7cfa09fccf068c4577014167ade5d6f2a81fa34449e6bbed2c'
RUNTIME_URL = 'https://github.com/n8n-io/nod/releases/download/nod-v0.9.4/nod-Runtime-win32-x64.tar.gz'
REPOSITORY = 'ebrahimhammad1/nod-windows10-experiment'
ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'build-source'
OUTPUT = ROOT / 'windows10-release'
EXPECTED = {
    'deployment/n8n/install.ps1', 'desktop/main/main.mjs',
    'desktop/scripts/build-windows-cross-local.mjs',
    'desktop/scripts/build-windows.mjs',
    'desktop/scripts/check-windows-esbuild.mjs',
    'desktop/scripts/check-windows-engine-smoke.mjs',
    'desktop/scripts/windows-compatibility.mjs',
    'desktop/scripts/windows-installer.nsi',
    'desktop/test/windows-compatibility.test.mjs',
}


def run(args, cwd=SOURCE, env=None, capture=False):
    return subprocess.run(args, cwd=cwd, env=env, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None).stdout


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url, path, expected_size=None, expected_hash=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=180) as response, path.open('wb') as stream:
        shutil.copyfileobj(response, stream, 1024 * 1024)
    if expected_size is not None and path.stat().st_size != expected_size:
        raise RuntimeError('Download size mismatch: ' + path.name)
    if expected_hash is not None and digest(path) != expected_hash:
        raise RuntimeError('Download SHA256 mismatch: ' + path.name)


def locked_windows_dependencies():
    lock = (SOURCE / 'pnpm-lock.yaml').read_text()
    packages = [('@esbuild/win32-x64', '0.28.2'),
                ('@img/sharp-win32-x64', '0.35.5'),
                ('@napi-rs/canvas-win32-x64-msvc', '1.1.1'),
                ('@agent-browser/cli-win32-x64-msvc', '0.43.0')]
    for name, version in packages:
        pattern = re.escape("'" + name + '@' + version + "':") + r'\n    resolution: \{integrity: ([^}]+)'
        match = re.search(pattern, lock)
        if not match:
            raise RuntimeError('Missing locked package integrity: ' + name)
        with urllib.request.urlopen('https://registry.npmjs.org/' + name + '/' + version, timeout=60) as response:
            metadata = json.load(response)
        url = metadata['dist']['tarball']
        if not url.startswith('https://registry.npmjs.org/'):
            raise RuntimeError('Unexpected package host')
        with urllib.request.urlopen(url, timeout=180) as response:
            content = response.read()
        actual = 'sha512-' + base64.b64encode(hashlib.sha512(content).digest()).decode()
        if actual != match.group(1):
            raise RuntimeError('Locked SHA512 mismatch: ' + name)
        target = SOURCE / 'node_modules' / name
        with tarfile.open(fileobj=io.BytesIO(content), mode='r:gz') as archive:
            if name.startswith('@agent-browser/'):
                executables = [item for item in archive.getmembers() if item.isfile() and item.name.endswith('.exe')]
                if len(executables) != 1:
                    raise RuntimeError('Unexpected agent-browser archive')
                binary = SOURCE / 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe'
                binary.write_bytes(archive.extractfile(executables[0]).read())
            else:
                for item in archive.getmembers():
                    if not item.isfile() or not item.name.startswith('package/'):
                        continue
                    relative = Path(item.name[len('package/'):])
                    if relative.is_absolute() or '..' in relative.parts:
                        raise RuntimeError('Unsafe package path')
                    path = target / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(archive.extractfile(item).read())
        print('Verified locked Windows dependency:', name, flush=True)


def prepare():
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise RuntimeError('This workflow is restricted to its approved public fork')
    if os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch':
        raise RuntimeError('Manual runs only')
    patch = ROOT / 'windows10-source.patch'
    if digest(patch) != PATCH_HASH:
        raise RuntimeError('Reviewed source patch mismatch')
    if run(['git', 'rev-parse', 'HEAD'], capture=True).strip() != BASE:
        raise RuntimeError('Upstream source mismatch')
    run(['git', 'apply', '--check', str(patch)])
    run(['git', 'apply', str(patch)])
    run(['git', 'add', '-A'])
    changed = set(run(['git', 'diff', '--cached', '--name-only'], capture=True).splitlines())
    if changed != EXPECTED:
        raise RuntimeError('Unexpected source modifications')
    # Disable inherited CI in the published exact-source branch too.
    shutil.rmtree(SOURCE / '.github/workflows')
    readme = SOURCE / 'README.md'
    original = readme.read_text()
    readme.write_text('# Nod n8n for Windows 10\n\n'
                      'Unofficial, experimental, unsigned build. Actual Windows 10 runtime compatibility has not been tested. '
                      'This is not an n8n release. Do not bypass Windows security or signature restrictions.\n\n'
                      'This branch contains the complete modified application source. '
                      'The installer is built from this commit. See the repository Releases for the installer, '
                      'full source archive, SHA256 hashes and build record. Installation on a real PC is not part of the build.\n\n'
                      'Base upstream commit: `' + BASE + '`. Reviewed patch SHA256: `' + PATCH_HASH + '`. '
                      'Inherited GitHub Actions workflows were removed only from this fork branch to prevent automatic or paid runs. '
                      'No application security checks were removed by that CI-only change.\n\n---\n\n' + original)
    run(['git', 'config', 'user.name', 'github-actions[bot]'])
    run(['git', 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
    run(['git', 'add', '-A'])
    run(['git', 'diff', '--cached', '--check'])
    run(['git', 'commit', '-m', 'build: prepare isolated unofficial Windows 10 source'])
    sha = run(['git', 'rev-parse', 'HEAD'], capture=True).strip()
    (ROOT / 'windows10-source-commit.txt').write_text(sha + '\n')
    OUTPUT.mkdir()
    with (OUTPUT / 'nod-windows10-source.tar.gz').open('wb') as stream:
        subprocess.run(['git', 'archive', '--format=tar.gz', '--prefix=nod-windows10-source/', 'HEAD'], cwd=SOURCE, stdout=stream, check=True)
    print('Prepared exact modified source commit:', sha, flush=True)


def build():
    environment = dict(os.environ, NOD_EXPERIMENTAL_WINDOWS10='true',
                       NOD_RUNTIME_REFRESH='2026-11-23', NOD_NSIS='/usr/bin/makensis')
    for key in ['NOD_RELEASE_BUILD', 'NOD_TRACES_TOKEN', 'NOD_DESKTOP_UPDATE_SOURCE_URL', 'GH_TOKEN', 'GITHUB_TOKEN']:
        environment.pop(key, None)
    run(['pnpm', 'install', '--frozen-lockfile'], env=environment)
    run(['pnpm', '--dir', 'desktop', 'install', '--frozen-lockfile'], env=environment)
    locked_windows_dependencies()
    run(['node', '--test', 'desktop/test/windows-compatibility.test.mjs', 'desktop/test/runtime-assets.test.mjs'], env=environment)
    fingerprint = run(['node', '--input-type=module', '-e',
                       'import {runtimeInputs} from "./desktop/scripts/runtime-inputs.mjs"; console.log((await runtimeInputs("win32-x64")).fingerprint)'], env=environment, capture=True).strip()
    manifest = json.loads((ROOT / 'windows10-runtime.json').read_text())
    if fingerprint != manifest['fingerprint'] or manifest['guest']['sha256'] != RUNTIME_HASH:
        raise RuntimeError('Official runtime fingerprint mismatch')
    assets = SOURCE / '.local/windows-runtime-assets'
    assets.mkdir(parents=True)
    download(RUNTIME_URL, assets / 'guest.tar.gz', manifest['guest']['bytes'], RUNTIME_HASH)
    manifest.pop('fingerprint')
    (assets / 'manifest.json').write_text(json.dumps(manifest))
    run(['pnpm', 'run', 'build'], env=environment)
    run(['node', 'desktop/scripts/build-windows-cross-local.mjs'], env=environment)
    installer = SOURCE / 'dist/windows/nod-Setup-x64.exe'
    run(['7z', 't', str(installer)], env=environment)
    with installer.open('rb') as stream:
        if stream.read(2) != b'MZ':
            raise RuntimeError('Invalid Windows executable')
    bundle = SOURCE / 'dist/windows/Nod-win32-x64'
    for relative in ['nod.exe', 'resources/engine/NOTICE', 'resources/engine/LICENSE',
                     'resources/engine/licenses/speech/NOTICE.md',
                     'resources/engine/licenses/speech/spellophone-source.tar.gz',
                     'resources/engine/licenses/speech/espeak-ng-source.tar.gz',
                     'resources/engine/node_modules/@esbuild/win32-x64/esbuild.exe',
                     'resources/engine/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.5.node',
                     'resources/engine/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
                     'resources/engine/node_modules/agent-browser/bin/agent-browser-win32-x64.exe']:
        if not (bundle / relative).is_file():
            raise RuntimeError('Missing expected packaged file: ' + relative)
    run(['node', 'desktop/scripts/check-windows-esbuild.mjs', str(bundle / 'resources/engine')], env=environment)
    sha = (ROOT / 'windows10-source-commit.txt').read_text().strip()
    package = json.loads((bundle / 'resources/app/package.json').read_text())
    if package['nodBuild']['source'] != sha or not package['nodBuild']['experimentalWindows10']:
        raise RuntimeError('Packaged source identity mismatch')
    shutil.copy2(installer, OUTPUT / 'nod-n8n-Windows10-0.9.4-unsigned.exe')
    shutil.copy2(ROOT / 'windows10-source.patch', OUTPUT / 'windows10-source.patch')
    shutil.copy2(ROOT / 'windows10-runtime.json', OUTPUT / 'windows10-runtime.json')
    record = {
        'title': 'Nod n8n for Windows 10', 'upstream_base': BASE, 'source_commit': sha,
        'source_patch_sha256': PATCH_HASH, 'runtime_guest_sha256': RUNTIME_HASH,
        'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'workflow_revision': os.environ['GITHUB_SHA'], 'runner_os': os.environ['RUNNER_OS'],
        'unofficial': True, 'unsigned': True, 'actual_windows10_runtime_tested': False,
        'node': run(['node', '--version'], capture=True).strip(),
        'pnpm': run(['pnpm', '--version'], capture=True).strip(),
        'go': run(['go', 'version'], capture=True).strip(),
        'nsis': run(['makensis', '-VERSION'], capture=True).strip(),
        'files': {path.name: {'bytes': path.stat().st_size, 'sha256': digest(path)} for path in sorted(OUTPUT.iterdir())}
    }
    (OUTPUT / 'build-record.json').write_text(json.dumps(record, indent=2) + '\n')
    (OUTPUT / 'SHA256SUMS').write_text(''.join(digest(path) + '  ' + path.name + '\n' for path in sorted(OUTPUT.iterdir()) if path.name != 'SHA256SUMS'))
    print('Unsigned installer built and archive integrity verified. Windows 10 runtime untested.', flush=True)


def publish():
    if not os.environ.get('GH_TOKEN'):
        raise RuntimeError('Missing temporary repository publish token')
    sha = (ROOT / 'windows10-source-commit.txt').read_text().strip()
    # No broad credentials or workflow-file write permission: source branch has no workflow files.
    askpass = ROOT / 'git-askpass.sh'
    askpass.write_text('#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$GH_TOKEN" ;; esac\n')
    askpass.chmod(0o700)
    environment = dict(os.environ, GIT_ASKPASS=str(askpass), GIT_TERMINAL_PROMPT='0')
    branch = 'windows10-source-' + os.environ['GITHUB_RUN_ID']
    tag = 'win10-0.9.4-build-' + os.environ['GITHUB_RUN_ID']
    try:
        run(['git', '-c', 'credential.helper=', 'push', 'https://github.com/' + REPOSITORY + '.git', sha + ':refs/heads/' + branch], env=environment)
        run(['git', 'tag', tag, sha])
        run(['git', '-c', 'credential.helper=', 'push', 'https://github.com/' + REPOSITORY + '.git', 'refs/tags/' + tag], env=environment)
    finally:
        askpass.unlink(missing_ok=True)
    notes = OUTPUT / 'RELEASE-NOTES.md'
    notes.write_text('## Unofficial experimental build\n\nUnsigned. Actual Windows 10 runtime compatibility has NOT been tested. '
                     'This is not an n8n release. Do not bypass SmartScreen, antivirus or signature restrictions.\n\n'
                     'Source-built on a standard free GitHub runner. This is a new CI build, not a byte-for-byte copy of an earlier local build. '
                     'No installation or execution on the user PC has occurred. Local startup uses WSL2 and may download the matching official 1.33GB guest archive when not cached. Includes the Windows esbuild optional dependency missing from the previous build. Publication is gated on native Windows packaged-engine smoke tests, not full Windows10+WSL startup.\n\n'
                     'Upstream base: `' + BASE + '`. Exact modified source commit: `' + sha + '`. '
                     'The full modified source archive and SHA256SUMS are attached. '
                     'See build-record.json for hashes, workflow identity and tool versions.\n')
    files = [str(path) for path in sorted(OUTPUT.iterdir()) if path != notes]
    run(['gh', 'release', 'create', tag, '--repo', REPOSITORY, '--verify-tag', '--prerelease', '--draft',
         '--title', 'Nod n8n for Windows 10', '--notes-file', str(notes), *files], env=environment)

    print('Draft release created. Windows packaged engine smoke must pass before publication.', flush=True)


if __name__ == '__main__':
    {'prepare': prepare, 'build': build, 'publish': publish}[sys.argv[1]]()
