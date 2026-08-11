import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CodexAppServerClient } from '../../src/app-server/client.mjs';
import { startConnectorServer } from '../../src/index.mjs';

const fixturePath = fileURLToPath(new URL('../../fixtures/fake-app-server.mjs', import.meta.url));

test('runs the checked-out connector end to end with a fake App Server', async (testContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'bookarium-connector-test-'));
  const origin = 'http://localhost:5173';
  const token = 'C'.repeat(43);
  const client = new CodexAppServerClient({
    appServerArgs: [fixturePath],
    command: process.execPath,
    environment: process.env,
    workspace: join(directory, 'workspace'),
  });
  const running = await startConnectorServer({ allowedOrigin: origin, client, port: 0, token });
  testContext.after(async () => {
    await running.close();
    await rm(directory, { force: true, recursive: true });
  });
  const baseUrl = `http://127.0.0.1:${running.address.port}`;
  const headers = { Authorization: `Bearer ${token}`, Origin: origin };

  const account = await fetch(`${baseUrl}/v1/account`, { headers });
  assert.equal(account.status, 200);
  assert.deepEqual(await account.json(), {
    account: { planType: 'plus', type: 'chatgpt' },
    version: 1,
  });

  const answer = await fetch(`${baseUrl}/v1/ask`, {
    body: JSON.stringify({ prompt: 'Explain the dative case.' }),
    headers: { ...headers, 'Content-Type': 'application/json' },
    method: 'POST',
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { answer: 'Tutor: Explain the dative case.' });
  assert.equal(running.address.address, '127.0.0.1');
});
