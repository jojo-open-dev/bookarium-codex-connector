import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { atomicWriteJson, pathExists } from '../../src/lifecycle/filesystem.mjs';
import { installPackage, readConnectorConfig } from '../../src/lifecycle/installation.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';
import {
  cleanStaleRuntimeState,
  probeManagedProcess,
  startManagedProcess,
  stopManagedProcess,
} from '../../src/lifecycle/process.mjs';
import { getControlPipeName } from '../../src/lifecycle/control-pipe.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

const setup = async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-process-test-'));
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
  const state = {
    controlPipe: getControlPipeName(config.installationId),
    installationId: config.installationId,
    pid: 42_424,
    protocolVersion: 1,
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    version: '0.1.0',
  };
  await atomicWriteJson(paths.dataRoot, paths.processFile, state);
  testContext.after(() => rm(root, { force: true, recursive: true }));
  return { config, environment, paths, root, state };
};

test('accepts a process only when the authenticated control identity matches state', async (testContext) => {
  const { config, paths, state } = await setup(testContext);
  const validControl = async ({ action, controlSecret, installationId, pipeName }) => {
    assert.equal(action, 'status');
    assert.equal(controlSecret, config.controlSecret);
    assert.equal(installationId, config.installationId);
    assert.equal(pipeName, state.controlPipe);
    return { installationId, ok: true, pid: state.pid, version: '0.1.0' };
  };
  assert.equal((await probeManagedProcess(paths, { control: validControl })).state.pid, state.pid);

  const reusedPidControl = async () => ({
    installationId: config.installationId,
    ok: true,
    pid: state.pid + 1,
    version: '0.1.0',
  });
  assert.equal(await probeManagedProcess(paths, { control: reusedPidControl }), null);
});

test('duplicate start returns the existing verified instance without spawning', async (testContext) => {
  const { config, environment, paths, state } = await setup(testContext);
  let spawned = false;
  const control = async () => ({
    installationId: config.installationId,
    ok: true,
    pid: state.pid,
    version: '0.1.0',
  });
  const result = await startManagedProcess(paths, {
    control,
    environment,
    spawnProcess: () => { spawned = true; },
  });
  assert.equal(result.alreadyRunning, true);
  assert.equal(spawned, false);
});

test('stop uses authenticated IPC and treats a PID-reuse mismatch as stale state', async (testContext) => {
  const { config, paths, root, state } = await setup(testContext);
  const sentinel = join(root, 'sentinel.txt');
  await writeFile(sentinel, 'keep', 'utf8');
  const reusedPidControl = async () => ({
    installationId: config.installationId,
    ok: true,
    pid: state.pid + 100,
    version: '0.1.0',
  });

  assert.equal(await stopManagedProcess(paths, { control: reusedPidControl }), false);
  assert.equal(await pathExists(paths.processFile), false);
  assert.equal(await pathExists(sentinel), true);
});

test('verified stop waits for control shutdown and removes only runtime state', async (testContext) => {
  const { config, paths, state } = await setup(testContext);
  await writeFile(paths.lockFile, 'stale-lock', 'utf8');
  let running = true;
  let processChecks = 0;
  const control = async ({ action }) => {
    if (action === 'stop') {
      running = false;
      return { installationId: config.installationId, ok: true, stopping: true };
    }
    return running
      ? { installationId: config.installationId, ok: true, pid: state.pid, version: '0.1.0' }
      : null;
  };
  const processAlive = () => {
    processChecks += 1;
    return processChecks < 3;
  };
  assert.equal(await stopManagedProcess(paths, { control, processAlive }), true);
  assert.equal(processChecks, 3);
  assert.equal(await pathExists(paths.processFile), false);
  assert.equal(await pathExists(paths.lockFile), false);
  await cleanStaleRuntimeState(paths);
});
