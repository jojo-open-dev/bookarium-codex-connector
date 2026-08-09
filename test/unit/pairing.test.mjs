import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generatePairingToken,
  isValidPairingToken,
  pairingTokenMatches,
} from '../../src/bridge/pairing.mjs';

test('generates 256 bits as an unpadded base64url token', () => {
  const source = Buffer.alloc(32, 0xab);
  const token = generatePairingToken((bytes) => {
    assert.equal(bytes, 32);
    return source;
  });
  assert.equal(token, source.toString('base64url'));
  assert.equal(token.length, 43);
  assert.equal(isValidPairingToken(token), true);
});

test('validates and compares pairing tokens without accepting alternate forms', () => {
  const token = 'A'.repeat(43);
  assert.equal(pairingTokenMatches(token, token), true);
  assert.equal(pairingTokenMatches(token, 'B'.repeat(43)), false);
  assert.equal(pairingTokenMatches(token, `${token}=`), false);
  assert.equal(pairingTokenMatches(token, null), false);
});
