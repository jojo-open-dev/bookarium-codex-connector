import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppServerProtocolError,
  encodeAppServerMessage,
  parseAppServerFrame,
  toSafeAccount,
} from '../../src/app-server/protocol.mjs';

test('encodes and parses newline-delimited App Server messages', () => {
  const encoded = encodeAppServerMessage({ id: 1, method: 'account/read', params: {} });
  assert.equal(encoded.endsWith('\n'), true);
  assert.deepEqual(parseAppServerFrame(encoded.trim()), {
    id: 1,
    method: 'account/read',
    params: {},
  });
});

test('fails closed on malformed and oversized App Server frames', () => {
  for (const frame of ['', '[]', '{}', '{not-json}', '{"id":null}']) {
    assert.throws(() => parseAppServerFrame(frame), AppServerProtocolError);
  }
  assert.throws(() => parseAppServerFrame('{"method":"x"}', 3), AppServerProtocolError);
});

test('returns only safe account metadata', () => {
  assert.deepEqual(toSafeAccount({
    account: {
      accessToken: 'secret',
      email: 'private@example.test',
      planType: 'plus',
      type: 'chatgpt',
    },
  }), { planType: 'plus', type: 'chatgpt' });
  assert.equal(toSafeAccount({ account: null }), null);
});
