import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getControlPipeName, sendControlRequest } from '../../src/lifecycle/control-pipe.mjs';
import { pathExists } from '../../src/lifecycle/filesystem.mjs';
import { installPackage, readConnectorConfig } from '../../src/lifecycle/installation.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';
import { runManagedService } from '../../src/runtime/managed-service.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for managed service test state.');
};

test('authenticates status and stop over the private control pipe', { skip: process.platform !== 'win32' }, async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-service-test-'));
  const environment = {
    ...process.env,
    APPDATA: join(root, 'Roaming'),
    LOCALAPPDATA: join(root, 'Local'),
  };
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
  const paths = createLifecyclePaths({ environment, packageRoot, platform: 'win32' });
  await installPackage(paths, { startupEnabled: false });
  const config = await readConnectorConfig(paths);
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const client = {
    ask: async (prompt) => prompt,
    readAccount: async () => ({ planType: 'plus', type: 'chatgpt' }),
    start: async () => {},
    stop: async () => {},
  };
  const service = runManagedService({ clientFactory: () => client, paths });
  await waitFor(() => pathExists(paths.processFile));
  const request = (action, controlSecret = config.controlSecret) => sendControlRequest({
    action,
    controlSecret,
    installationId: config.installationId,
    pipeName: getControlPipeName(config.installationId),
  });

  assert.deepEqual(await request('status', 'D'.repeat(43)), { ok: false });
  const status = await request('status');
  assert.equal(status.ok, true);
  assert.equal(status.pid, process.pid);
  const stopped = await request('stop');
  assert.equal(stopped.stopping, true);
  await service;
  assert.equal(await pathExists(paths.processFile), false);
  assert.equal(await pathExists(paths.lockFile), false);
});
