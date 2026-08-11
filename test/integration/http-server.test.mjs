import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeServer } from '../../src/bridge/http-server.mjs';
import { ConnectorBusyError } from '../../src/app-server/client.mjs';
import { MAX_BODY_BYTES, PROTOCOL_VERSION } from '../../src/constants.mjs';

const origin = 'http://localhost:5173';
const token = 'A'.repeat(43);
const authorizedHeaders = { Authorization: `Bearer ${token}`, Origin: origin };

const startServer = async (testContext, client = {
  ask: async (prompt) => `Answer: ${prompt}`,
  readAccount: async () => ({ planType: 'plus', type: 'chatgpt' }),
}, options = {}) => {
  const server = createBridgeServer({ allowedOrigin: origin, client, token, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  testContext.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return `http://127.0.0.1:${server.address().port}`;
};

test('exchanges an origin-bound pairing request once and authorizes only the issued token', async (testContext) => {
  const pairingCode = 'P'.repeat(43);
  const issuedToken = 'T'.repeat(43);
  let pending = pairingCode;
  let active = null;
  const pairing = {
    authenticate: async (supplied) => supplied === active,
    exchange: async (supplied) => {
      if (supplied !== pending) return null;
      pending = null;
      active = issuedToken;
      return issuedToken;
    },
  };
  const baseUrl = await startServer(testContext, undefined, { pairing });

  const preflight = await fetch(`${baseUrl}/v1/pair`, {
    headers: {
      'Access-Control-Request-Headers': 'content-type',
      'Access-Control-Request-Method': 'POST',
      Origin: origin,
    },
    method: 'OPTIONS',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');

  const wrongOrigin = await fetch(`${baseUrl}/v1/pair`, {
    body: JSON.stringify({ pairingCode }),
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    method: 'POST',
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get('access-control-allow-origin'), null);

  const malformed = await fetch(`${baseUrl}/v1/pair`, {
    body: JSON.stringify({ pairingCode: 'malformed' }),
    headers: { 'Content-Type': 'application/json', Origin: origin },
    method: 'POST',
  });
  assert.equal(malformed.status, 401);

  const paired = await fetch(`${baseUrl}/v1/pair`, {
    body: JSON.stringify({ pairingCode }),
    headers: { 'Content-Type': 'application/json', Origin: origin },
    method: 'POST',
  });
  assert.equal(paired.status, 200);
  assert.deepEqual(await paired.json(), { token: issuedToken, version: PROTOCOL_VERSION });
  assert.equal(paired.headers.get('cache-control'), 'no-store');

  const replay = await fetch(`${baseUrl}/v1/pair`, {
    body: JSON.stringify({ pairingCode }),
    headers: { 'Content-Type': 'application/json', Origin: origin },
    method: 'POST',
  });
  assert.equal(replay.status, 401);

  const account = await fetch(`${baseUrl}/v1/account`, {
    headers: { Authorization: `Bearer ${issuedToken}`, Origin: origin },
  });
  assert.equal(account.status, 200);
});

test('exposes minimal unauthenticated readiness without CORS or account data', async (testContext) => {
  const baseUrl = await startServer(testContext);
  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true, version: PROTOCOL_VERSION });
  assert.equal(response.headers.get('access-control-allow-origin'), null);

  const wrongMethod = await fetch(`${baseUrl}/readyz`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
});

test('requires the exact origin and pairing token on account access', async (testContext) => {
  const baseUrl = await startServer(testContext, {
    ask: async (prompt) => prompt,
    readAccount: async () => ({
      accessToken: 'must-not-cross-http-boundary',
      email: 'private@example.test',
      planType: 'plus',
      type: 'chatgpt',
    }),
  });
  for (const invalidOrigin of [undefined, 'null', 'https://attacker.example', `${origin}/`]) {
    const headers = { Authorization: `Bearer ${token}` };
    if (invalidOrigin !== undefined) headers.Origin = invalidOrigin;
    const response = await fetch(`${baseUrl}/v1/account`, { headers });
    assert.equal(response.status, 403, String(invalidOrigin));
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }

  const wrongToken = await fetch(`${baseUrl}/v1/account`, {
    headers: { Authorization: `Bearer ${'B'.repeat(43)}`, Origin: origin },
  });
  assert.equal(wrongToken.status, 401);
  assert.equal(wrongToken.headers.get('access-control-allow-origin'), origin);

  const response = await fetch(`${baseUrl}/v1/account`, { headers: authorizedHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account: { planType: 'plus', type: 'chatgpt' },
    version: PROTOCOL_VERSION,
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('returns a narrow preflight only for the endpoint contract', async (testContext) => {
  const baseUrl = await startServer(testContext);
  const response = await fetch(`${baseUrl}/v1/ask`, {
    headers: {
      'Access-Control-Request-Headers': 'authorization, content-type',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Private-Network': 'true',
      Origin: origin,
    },
    method: 'OPTIONS',
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');

  const broad = await fetch(`${baseUrl}/v1/ask`, {
    headers: {
      'Access-Control-Request-Headers': 'authorization, x-extra',
      'Access-Control-Request-Method': 'POST',
      Origin: origin,
    },
    method: 'OPTIONS',
  });
  assert.equal(broad.status, 403);
});

test('accepts only bounded JSON study questions for ChatGPT accounts', async (testContext) => {
  const baseUrl = await startServer(testContext);
  const response = await fetch(`${baseUrl}/v1/ask`, {
    body: JSON.stringify({ prompt: 'Explain this word.' }),
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    method: 'POST',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answer: 'Answer: Explain this word.' });

  const unsupportedField = await fetch(`${baseUrl}/v1/ask`, {
    body: JSON.stringify({ command: 'whoami', prompt: 'Explain.' }),
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    method: 'POST',
  });
  assert.equal(unsupportedField.status, 400);

  const wrongType = await fetch(`${baseUrl}/v1/ask`, {
    body: '{}',
    headers: { ...authorizedHeaders, 'Content-Type': 'text/plain' },
    method: 'POST',
  });
  assert.equal(wrongType.status, 415);

  const oversized = await fetch(`${baseUrl}/v1/ask`, {
    body: JSON.stringify({ prompt: 'x'.repeat(MAX_BODY_BYTES) }),
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    method: 'POST',
  });
  assert.equal(oversized.status, 413);
});

test('refuses non-ChatGPT authentication and concurrent tutor turns', async (testContext) => {
  let active = false;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const baseUrl = await startServer(testContext, {
    ask: async (prompt) => {
      if (active) throw new ConnectorBusyError();
      active = true;
      await released;
      active = false;
      return prompt;
    },
    readAccount: async () => ({ type: 'chatgpt' }),
  });
  const request = () => fetch(`${baseUrl}/v1/ask`, {
    body: JSON.stringify({ prompt: 'Explain.' }),
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    method: 'POST',
  });

  const first = request();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await request();
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);

  const apiKeyUrl = await startServer(testContext, {
    ask: async () => 'unused',
    readAccount: async () => ({ type: 'apiKey' }),
  });
  const apiKey = await fetch(`${apiKeyUrl}/v1/ask`, {
    body: JSON.stringify({ prompt: 'Explain.' }),
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    method: 'POST',
  });
  assert.equal(apiKey.status, 409);
  assert.match((await apiKey.json()).error, /signed in with ChatGPT/u);
});
