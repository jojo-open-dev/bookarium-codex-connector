import { spawn } from 'node:child_process';
import { lstat, unlink } from 'node:fs/promises';
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT, PACKAGE_VERSION, PROTOCOL_VERSION } from '../constants.mjs';
import { toSafeAccount } from '../app-server/protocol.mjs';
import { isValidPairingToken } from '../bridge/pairing.mjs';
import { assertNoLinksInPath, pathExists, readJsonFile } from './filesystem.mjs';
import { getControlPipeName, sendControlRequest } from './control-pipe.mjs';
import { readConnectorConfig, readLifecycle, verifyInstalledVersion } from './installation.mjs';
import { createPairingAuthority } from './pairing-state.mjs';

const STARTUP_TIMEOUT_MS = 30_000;
const STALE_LOCK_AGE_MS = 30_000;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

export const readProcessState = async (paths) => {
  if (!await pathExists(paths.processFile)) return null;
  await assertNoLinksInPath(paths.dataRoot, paths.processFile);
  const value = await readJsonFile(paths.processFile);
  if (value.schemaVersion !== 1
    || value.version !== PACKAGE_VERSION
    || value.protocolVersion !== PROTOCOL_VERSION
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || !/^[a-f0-9]{32}$/u.test(value.installationId)
    || value.controlPipe !== getControlPipeName(value.installationId)
    || Number.isNaN(Date.parse(value.startedAt))) {
    throw new Error('Connector process state is invalid.');
  }
  return value;
};

export const probeManagedProcess = async (paths, { control = sendControlRequest } = {}) => {
  const config = await readConnectorConfig(paths);
  let state;
  try {
    state = await readProcessState(paths);
  } catch {
    return null;
  }
  if (!state || state.installationId !== config.installationId) return null;
  const response = await control({
    action: 'status',
    controlSecret: config.controlSecret,
    installationId: config.installationId,
    pipeName: getControlPipeName(config.installationId),
  });
  if (!response?.ok
    || response.installationId !== config.installationId
    || response.pid !== state.pid
    || response.version !== PACKAGE_VERSION) return null;
  return { response, state };
};

const unlinkOwnedRuntimeFile = async (paths, path) => {
  if (!await pathExists(path)) return;
  await assertNoLinksInPath(paths.dataRoot, path);
  await unlink(path);
};

export const cleanStaleRuntimeState = async (paths) => {
  await unlinkOwnedRuntimeFile(paths, paths.processFile);
  await unlinkOwnedRuntimeFile(paths, paths.lockFile);
};

const waitForExistingStartup = async (paths, options) => {
  if (!await pathExists(paths.lockFile)) return null;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = await probeManagedProcess(paths, options).catch(() => null);
    if (running) return running;
    const stats = await lstat(paths.lockFile).catch(() => null);
    if (!stats) return null;
    if ((Date.now() - stats.mtimeMs) >= STALE_LOCK_AGE_MS) break;
    await delay(100);
  }
  await cleanStaleRuntimeState(paths);
  return null;
};

export const startManagedProcess = async (paths, {
  control = sendControlRequest,
  environment = process.env,
  spawnProcess = spawn,
} = {}) => {
  await verifyInstalledVersion(paths);
  const config = await readConnectorConfig(paths);
  const lifecycle = await readLifecycle(paths);
  const options = { control };
  const alreadyRunning = await probeManagedProcess(paths, options).catch(() => null)
    ?? await waitForExistingStartup(paths, options);
  if (alreadyRunning) return { alreadyRunning: true, ...alreadyRunning };
  await cleanStaleRuntimeState(paths);

  let child;
  try {
    child = spawnProcess(lifecycle.nodePath, [paths.installedBinary, 'run-managed'], {
      cwd: paths.versionRoot,
      detached: true,
      env: environment,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    throw new Error('The managed connector process could not be started.');
  }
  let childFailed = false;
  child.once('error', () => { childFailed = true; });
  child.once('exit', () => { childFailed = true; });
  child.unref();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = await probeManagedProcess(paths, options).catch(() => null);
    if (running) return { alreadyRunning: false, ...running };
    if (childFailed) break;
    await delay(100);
  }
  throw new Error('The connector did not become ready. Run repair after checking the Codex installation.');
};

export const stopManagedProcess = async (paths, {
  control = sendControlRequest,
  processAlive = isProcessAlive,
} = {}) => {
  const config = await readConnectorConfig(paths);
  const options = { control };
  const running = await probeManagedProcess(paths, options).catch(() => null)
    ?? await waitForExistingStartup(paths, options);
  if (!running) {
    await cleanStaleRuntimeState(paths);
    return false;
  }
  const response = await control({
    action: 'stop',
    controlSecret: config.controlSecret,
    installationId: config.installationId,
    pipeName: getControlPipeName(config.installationId),
  });
  if (!response?.ok || response.installationId !== config.installationId) {
    throw new Error('The connector refused the verified stop request.');
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!processAlive(running.state.pid)) {
      await cleanStaleRuntimeState(paths);
      return true;
    }
    await delay(100);
  }
  throw new Error('The connector did not stop within the expected time.');
};

const sendVerifiedRuntimeAction = async (paths, action, {
  control = sendControlRequest,
} = {}) => {
  const config = await readConnectorConfig(paths);
  const running = await probeManagedProcess(paths, { control }).catch(() => null);
  if (!running) throw new Error('The connector must be running for this operation.');
  const response = await control({
    action,
    controlSecret: config.controlSecret,
    installationId: config.installationId,
    pipeName: getControlPipeName(config.installationId),
  });
  if (!response?.ok
    || response.installationId !== config.installationId
    || response.pid !== running.state.pid
    || response.version !== PACKAGE_VERSION) {
    throw new Error('The connector refused the authenticated control request.');
  }
  return { config, response, running };
};

export const beginManagedPairing = async (paths, options = {}) => {
  const { response } = await sendVerifiedRuntimeAction(paths, 'beginPairing', options);
  if (!isValidPairingToken(response.pairingCode)
    || !Number.isSafeInteger(response.expiresAt)
    || response.expiresAt <= Date.now()) {
    throw new Error('The connector returned an invalid pairing request.');
  }
  return { expiresAt: response.expiresAt, pairingCode: response.pairingCode };
};

export const revokeManagedPairing = async (paths, {
  control = sendControlRequest,
} = {}) => {
  const config = await readConnectorConfig(paths);
  const running = await probeManagedProcess(paths, { control }).catch(() => null);
  if (running) {
    const { response } = await sendVerifiedRuntimeAction(paths, 'revokePairing', { control });
    if (response.revoked !== true) throw new Error('The connector did not revoke browser pairing.');
    return true;
  }
  const recordedProcess = await readProcessState(paths).catch(() => null);
  if (recordedProcess && isProcessAlive(recordedProcess.pid)) {
    throw new Error('Browser pairing could not be revoked while connector identity was unverified.');
  }
  const pairing = createPairingAuthority(paths, {
    allowedOrigin: config.allowedOrigin,
    installationId: config.installationId,
  });
  await pairing.revoke();
  return true;
};

export const getManagedStatus = async (paths, { control = sendControlRequest } = {}) => {
  const config = await readConnectorConfig(paths);
  const running = await probeManagedProcess(paths, { control }).catch(() => null);
  let account = null;
  const pairingAuthority = createPairingAuthority(paths, {
    allowedOrigin: config.allowedOrigin,
    installationId: config.installationId,
  });
  const pairing = await pairingAuthority.status();
  if (running) {
    try {
      const response = await control({
        action: 'inspect',
        controlSecret: config.controlSecret,
        installationId: config.installationId,
        pipeName: getControlPipeName(config.installationId),
      });
      if (response?.ok
        && response.installationId === config.installationId
        && response.pid === running.state.pid
        && response.version === PACKAGE_VERSION) {
        account = toSafeAccount({ account: response.account });
      }
    } catch {
      account = null;
    }
  }
  return {
    account,
    address: `${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`,
    allowedOrigin: config.allowedOrigin,
    pairing,
    protocolVersion: PROTOCOL_VERSION,
    running: Boolean(running),
    version: PACKAGE_VERSION,
  };
};
