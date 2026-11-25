'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('quit releases shortcuts without waiting for a telemetry flush', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main-companion.js'), 'utf8');
  const cleanup = main.slice(main.indexOf("app.on('will-quit'"), main.indexOf("app.on('window-all-closed'"));
  assert.match(cleanup, /unregisterShortcuts/);
  assert.doesNotMatch(cleanup, /preventDefault|stats|app\.quit/);
});
