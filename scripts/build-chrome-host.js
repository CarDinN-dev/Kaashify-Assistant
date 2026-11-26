'use strict';

const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const output = path.join(root, 'build', 'chrome');
mkdirSync(output, { recursive: true });
const go = process.env.KAASHIFY_GO || 'go';
const build = spawnSync(go, ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -H=windowsgui',
  '-o', path.join(output, 'KaashifyChromeHost.exe'), path.join(root, 'tools', 'chrome-host', 'main.go')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
});
if (build.error) console.error('Install the Go toolchain or set KAASHIFY_GO to its executable.');
if (build.status === 0) copyFileSync(path.join(root, 'tools', 'chrome-host', 'LICENSE-Go'), path.join(output, 'LICENSE-Go'));
process.exitCode = build.status ?? 1;
