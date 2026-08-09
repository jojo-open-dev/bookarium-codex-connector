import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  createPairingUrl,
  openBrowser,
  PAIRING_FRAGMENT_KEY,
} from '../../src/lifecycle/browser.mjs';

test('puts pairing material only in the approved Bookarium URL fragment', () => {
  const pairingCode = 'A'.repeat(43);
  const value = createPairingUrl('https://bienemaja.app', pairingCode);
  const url = new URL(value);
  assert.equal(url.origin, 'https://bienemaja.app');
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get(PAIRING_FRAGMENT_KEY), pairingCode);
  assert.throws(() => createPairingUrl('https://attacker.example/path', pairingCode));
  assert.throws(() => createPairingUrl('https://bienemaja.app', 'short'));
});

test('opens the pairing URL on Windows without a shell', async () => {
  const calls = [];
  let unrefCalled = false;
  const spawnProcess = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.unref = () => { unrefCalled = true; };
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  const url = createPairingUrl('https://bienemaja.app', 'B'.repeat(43));
  await openBrowser(url, { platform: 'win32', spawnProcess });
  assert.equal(calls[0][0], 'explorer.exe');
  assert.deepEqual(calls[0][1], [url]);
  assert.equal(calls[0][2].shell, false);
  assert.equal(unrefCalled, true);
});
