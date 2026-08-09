import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeOrigin,
  requestOriginMatches,
  requireAllowedOrigin,
} from '../../src/bridge/origin-policy.mjs';

test('normalizes configured HTTP and HTTPS origins', () => {
  assert.equal(normalizeOrigin('https://bookarium.example/'), 'https://bookarium.example');
  assert.equal(normalizeOrigin('https://bookarium.example:443'), 'https://bookarium.example');
  assert.equal(normalizeOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
});

test('rejects malformed, opaque, wildcard, credentialed, and path origins', () => {
  for (const value of [
    null,
    '',
    'null',
    '*',
    'file:///tmp/index.html',
    'https://bookarium.example/path',
    'https://user:pass@bookarium.example',
    'https://bookarium.example?query=1',
    ' https://bookarium.example',
  ]) {
    assert.equal(normalizeOrigin(value), null, String(value));
  }
  assert.throws(() => requireAllowedOrigin('null'), /valid HTTP or HTTPS/u);
});

test('requires the browser serialization of the exact configured origin', () => {
  const allowed = requireAllowedOrigin('https://bookarium.example/');
  assert.equal(requestOriginMatches('https://bookarium.example', allowed), true);
  assert.equal(requestOriginMatches('https://bookarium.example/', allowed), false);
  assert.equal(requestOriginMatches('https://sub.bookarium.example', allowed), false);
  assert.equal(requestOriginMatches('https://bookarium.example.attacker.test', allowed), false);
  assert.equal(requestOriginMatches('null', allowed), false);
});
