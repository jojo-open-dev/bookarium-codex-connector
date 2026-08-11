import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CodexAppServerClient,
  ConnectorBusyError,
  UnsafeToolActivityError,
} from '../../src/app-server/client.mjs';
import { STUDY_ASSISTANT_INSTRUCTIONS } from '../../src/constants.mjs';

const fixturePath = fileURLToPath(new URL('../../fixtures/fake-app-server.mjs', import.meta.url));

const createFixtureClient = async (testContext, extraEnvironment = {}, clientOptions = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'bookarium-client-test-'));
  const auditPath = join(directory, 'audit.jsonl');
  const spawns = [];
  const client = new CodexAppServerClient({
    appServerArgs: [fixturePath],
    command: process.execPath,
    environment: {
      ...process.env,
      FAKE_APP_SERVER_AUDIT_PATH: auditPath,
      ...extraEnvironment,
    },
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, options);
      spawns.push({ args, child, command, options });
      return child;
    },
    turnTimeoutMs: 2_000,
    workspace: join(directory, 'workspace'),
    ...clientOptions,
  });
  testContext.after(async () => {
    await client.stop();
    for (const { child } of spawns) {
      if (!childExited(child)) child.kill('SIGKILL');
    }
    await rm(directory, { force: true, recursive: true });
  });
  return { auditPath, client, spawns };
};

const readAudit = async (path) => (await readFile(path, 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

test('spawns App Server without a shell and returns only safe account data', async (testContext) => {
  const { auditPath, client, spawns } = await createFixtureClient(testContext);
  assert.deepEqual(client.appServerArgs, [fixturePath]);
  const account = await client.readAccount();

  assert.deepEqual(account, { planType: 'plus', type: 'chatgpt' });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.deepEqual(spawns[0].args, [fixturePath]);
  assert.equal(spawns[0].options.shell, false);
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);

  const audit = await readAudit(auditPath);
  assert.equal(audit[0].method, 'initialize');
  assert.equal(audit[1].method, 'initialized');
  assert.deepEqual(audit[2], {
    id: 2,
    method: 'account/read',
    params: { refreshToken: false },
  });
});

test('uses stdio and clears MCP servers in the production spawn arguments', () => {
  const client = new CodexAppServerClient();
  assert.deepEqual(client.appServerArgs, [
    'app-server',
    '--listen',
    'stdio://',
    '--config',
    'mcp_servers={}',
  ]);
});

test('uses a fresh ephemeral read-only and no-network tutor thread for each answer', async (testContext) => {
  const { auditPath, client } = await createFixtureClient(testContext);

  assert.equal(await client.ask('Explain der Hund.'), 'Tutor: Explain der Hund.');
  assert.equal(await client.ask('Explain die Katze.'), 'Tutor: Explain die Katze.');
  await new Promise((resolve) => setImmediate(resolve));

  const audit = await readAudit(auditPath);
  const threadStarts = audit.filter((message) => message.method === 'thread/start');
  const turnStarts = audit.filter((message) => message.method === 'turn/start');
  assert.equal(threadStarts.length, 2);
  assert.equal(turnStarts.length, 2);
  for (const request of threadStarts) {
    assert.equal(request.params.approvalPolicy, 'never');
    assert.equal(request.params.sandbox, 'read-only');
    assert.equal(request.params.ephemeral, true);
    assert.equal(request.params.baseInstructions, STUDY_ASSISTANT_INSTRUCTIONS);
    assert.equal(request.params.developerInstructions, STUDY_ASSISTANT_INSTRUCTIONS);
  }
  for (const request of turnStarts) {
    assert.equal(request.params.approvalPolicy, 'never');
    assert.equal(request.params.cwd, client.workspace);
    assert.deepEqual(request.params.sandboxPolicy, {
      networkAccess: false,
      type: 'readOnly',
    });
  }
});

test('fails a tutor request when App Server reports unsafe tool activity', async (testContext) => {
  const { client } = await createFixtureClient(testContext, { FAKE_APP_SERVER_UNSAFE_TOOL: '1' });
  await assert.rejects(() => client.ask('Run a command.'), UnsafeToolActivityError);
});

test('rejects server-initiated host actions instead of forwarding them', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_HOST_REQUEST: '1',
  });
  await assert.rejects(() => client.ask('Request approval.'), UnsafeToolActivityError);
  assert.equal(childExited(spawns[0].child), true);
});

const childExited = (child) => child.exitCode !== null || child.signalCode !== null;

test('terminates App Server when an unsafe item races the turn-start response', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_COALESCED_UNSAFE_TOOL: '1',
  });
  await assert.rejects(() => client.ask('Run a command.'), UnsafeToolActivityError);
  assert.equal(childExited(spawns[0].child), true);
});

test('fails closed on an unrecognized App Server item type', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_UNKNOWN_ITEM: '1',
  });
  await assert.rejects(() => client.ask('Explain.'), UnsafeToolActivityError);
  assert.equal(childExited(spawns[0].child), true);
});

test('bounds aggregate output across distinct App Server item ids', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_MANY_ITEMS: '1',
  }, {
    maximumResponseBytes: 8,
    turnTimeoutMs: 200,
  });
  await assert.rejects(() => client.ask('Explain.'), /response limit/u);
  assert.equal(childExited(spawns[0].child), true);
});

test('bounds distinct answer item ids even below the aggregate byte limit', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_MANY_ITEMS: '1',
  }, {
    maximumItemCount: 2,
    maximumResponseBytes: 100,
    turnTimeoutMs: 200,
  });
  await assert.rejects(() => client.ask('Explain.'), /item limit/u);
  assert.equal(childExited(spawns[0].child), true);
});

test('bounds total turn events independently of item and byte limits', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_MANY_ITEMS: '1',
  }, {
    maximumItemCount: 10,
    maximumResponseBytes: 100,
    maximumTurnEvents: 2,
    turnTimeoutMs: 200,
  });
  await assert.rejects(() => client.ask('Explain.'), /event limit/u);
  assert.equal(childExited(spawns[0].child), true);
});

test('terminates App Server after fatal protocol output', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_MALFORMED_FRAME: '1',
  });
  await assert.rejects(() => client.ask('Explain.'), /protocol failed closed/u);
  assert.equal(childExited(spawns[0].child), true);
});

test('terminates App Server before releasing a timed-out turn', async (testContext) => {
  const { client, spawns } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_STALLED_TURN: '1',
  }, {
    turnTimeoutMs: 100,
  });
  await assert.rejects(() => client.ask('Explain.'), /too long/u);
  assert.equal(childExited(spawns[0].child), true);
});

test('bounds pending App Server requests independently of HTTP admission', async (testContext) => {
  const { client } = await createFixtureClient(testContext, {
    FAKE_APP_SERVER_STALLED_ACCOUNT: '1',
  }, {
    maximumPendingRequests: 2,
  });
  await client.start();
  const first = client.readAccount().catch((error) => error);
  const second = client.readAccount().catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => client.readAccount(), ConnectorBusyError);
  await client.stop();
  await Promise.all([first, second]);
});
