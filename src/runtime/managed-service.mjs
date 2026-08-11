import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { createServer as createControlServer } from 'node:net';
import { CodexAppServerClient } from '../app-server/client.mjs';
import { pairingTokenMatches } from '../bridge/pairing.mjs';
import { DEFAULT_BRIDGE_PORT, PACKAGE_VERSION, PROTOCOL_VERSION } from '../constants.mjs';
import { startConnectorServer } from '../index.mjs';
import { getControlPipeName } from '../lifecycle/control-pipe.mjs';
import {
  assertNoLinksInPath,
  atomicWriteJson,
  pathExists,
  readJsonFile,
} from '../lifecycle/filesystem.mjs';
import {
  readConnectorConfig,
  readLifecycle,
  readOwnership,
  verifyInstalledVersion,
} from '../lifecycle/installation.mjs';
import { createLifecyclePaths } from '../lifecycle/paths.mjs';
import { readProcessState } from '../lifecycle/process.mjs';

const MAX_CONTROL_REQUEST_BYTES = 4 * 1_024;

const listen = (server, target) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(target, () => {
    server.off('error', reject);
    resolve();
  });
});

const closeServer = (server) => new Promise((resolve) => {
  if (!server?.listening) {
    resolve();
    return;
  }
  server.close(() => resolve());
});

const createAuthenticatedControlServer = ({ config, onStop }) => createControlServer((socket) => {
  socket.on('error', () => {});
  let bytes = 0;
  let handled = false;
  const chunks = [];
  socket.setTimeout(2_000, () => socket.destroy());
  socket.on('data', (chunk) => {
    if (handled) return;
    bytes += chunk.length;
    if (bytes > MAX_CONTROL_REQUEST_BYTES) {
      handled = true;
      socket.end(JSON.stringify({ ok: false }));
      return;
    }
    chunks.push(chunk);
    const combined = Buffer.concat(chunks);
    const newline = combined.indexOf(0x0a);
    if (newline < 0) return;
    handled = true;

    let request;
    try {
      request = JSON.parse(combined.subarray(0, newline).toString('utf8'));
    } catch {
      socket.end(JSON.stringify({ ok: false }));
      return;
    }
    if (request?.installationId !== config.installationId
      || !pairingTokenMatches(config.controlSecret, request?.controlSecret)) {
      socket.end(JSON.stringify({ ok: false }));
      return;
    }
    const response = {
      installationId: config.installationId,
      ok: true,
      pid: process.pid,
      version: PACKAGE_VERSION,
    };
    if (request.action === 'status') {
      socket.end(JSON.stringify(response));
    } else if (request.action === 'stop') {
      socket.end(JSON.stringify({ ...response, stopping: true }));
      setImmediate(onStop);
    } else {
      socket.end(JSON.stringify({ ok: false }));
    }
  });
});

export const runManagedService = async ({
  clientFactory = (lifecycle, paths) => new CodexAppServerClient({
    command: lifecycle.codexCommand,
    workspace: paths.workspace,
  }),
  paths = createLifecyclePaths(),
} = {}) => {
  const ownership = await readOwnership(paths);
  const config = await readConnectorConfig(paths);
  const lifecycle = await readLifecycle(paths);
  await verifyInstalledVersion(paths);
  if (config.installationId !== ownership.installationId) throw new Error('Connector installation identity mismatch.');

  await assertNoLinksInPath(paths.dataRoot, paths.lockFile, { includeLeaf: false });
  const lockNonce = randomBytes(16).toString('hex');
  let lockHandle;
  try {
    lockHandle = await open(paths.lockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('A managed connector startup is already in progress.');
    throw error;
  }
  await lockHandle.writeFile(`${JSON.stringify({
    installationId: ownership.installationId,
    nonce: lockNonce,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })}\n`, 'utf8');
  await lockHandle.sync();

  let connector = null;
  let controlServer = null;
  let shuttingDown = false;
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await closeServer(controlServer);
    await connector?.close().catch(() => {});
    try {
      const current = await readProcessState(paths);
      if (current?.pid === process.pid && current.installationId === ownership.installationId) {
        await unlink(paths.processFile);
      }
    } catch {
      // Leave unverified state untouched for repair.
    }
    await lockHandle.close().catch(() => {});
    try {
      const lock = await readJsonFile(paths.lockFile);
      if (lock.nonce === lockNonce && lock.pid === process.pid) await unlink(paths.lockFile);
    } catch {
      // Leave an unverified lock untouched for stale-state recovery.
    }
    finish();
  };

  try {
    const client = clientFactory(lifecycle, paths);
    connector = await startConnectorServer({
      allowedOrigin: config.allowedOrigin,
      client,
      port: DEFAULT_BRIDGE_PORT,
      token: config.pairingToken,
    });
    controlServer = createAuthenticatedControlServer({ config, onStop: shutdown });
    const controlPipe = getControlPipeName(config.installationId);
    await listen(controlServer, controlPipe);
    await atomicWriteJson(paths.dataRoot, paths.processFile, {
      controlPipe,
      installationId: config.installationId,
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      version: PACKAGE_VERSION,
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await stopped;
  } catch (error) {
    await shutdown();
    throw error;
  } finally {
    if (await pathExists(paths.lockFile).catch(() => false)) await shutdown();
  }
};
