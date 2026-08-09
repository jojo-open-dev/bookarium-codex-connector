import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  installCommand,
  pairCommand,
  repairCommand,
  revokeCommand,
  statusCommand,
  uninstallCommand,
} from '../../src/commands/lifecycle.mjs';
import { pathExists } from '../../src/lifecycle/filesystem.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const capture = () => ({ data: '', write(value) { this.data += value; } });

test('installs, reports, repairs, and uninstalls only an isolated owned tree', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-lifecycle-test-'));
  const environment = {
    ...process.env,
    APPDATA: join(root, 'Roaming'),
    LOCALAPPDATA: join(root, 'Local'),
  };
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
  const paths = createLifecyclePaths({ environment, packageRoot, platform: 'win32' });
  const sentinel = join(root, 'keep.txt');
  await writeFile(sentinel, 'keep', 'utf8');
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const output = capture();
  const prerequisiteCheck = async () => ({
    codexArgsPrefix: [],
    codexCommand: process.execPath,
    codexVersion: 'codex-cli test',
    nodeVersion: process.versions.node,
  });
  const start = async () => ({ alreadyRunning: false });
  let activationState = null;
  const activation = {
    create: async (activationPaths) => {
      activationState = {
        command: 'fixed start-managed command',
        description: 'URL:Bookarium Codex Connector',
        registryPath: activationPaths.activationRegistryPath,
        scheme: activationPaths.activationScheme,
        uri: activationPaths.activationUri,
      };
      return activationState;
    },
    matches: (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected),
    read: async () => activationState,
    remove: async (activationPaths, expected) => {
      assert.equal(activationPaths, paths);
      assert.deepEqual(expected, activationState);
      activationState = null;
      return true;
    },
  };
  const pairingCode = 'P'.repeat(43);
  let openedUrl = null;

  await assert.rejects(() => installCommand(['--startup', '--no-startup'], {
    activation,
    environment,
    output,
    paths,
    prerequisiteCheck,
    start,
  }), /cannot be used together/u);

  assert.equal(await installCommand([], {
    activation,
    environment,
    beginPairing: async () => ({ expiresAt: Date.now() + 60_000, pairingCode }),
    browserOpen: async (url) => { openedUrl = url; },
    output,
    paths,
    prerequisiteCheck,
    start,
  }), 0);
  assert.equal(await pathExists(paths.dataRoot), true);
  assert.equal(activationState.uri, 'bookarium-codex://connect');
  assert.doesNotMatch(output.data, /[A-Za-z0-9_-]{43}/u);
  assert.match(openedUrl, /^https:\/\/bienemaja\.app\/#bookarium-codex-pairing=/u);
  assert.equal(new URL(openedUrl).hash.includes(pairingCode), true);
  assert.match(output.data, /Start-Process 'bookarium-codex:\/\/connect'/u);

  output.data = '';
  assert.equal(await statusCommand({
    activation,
    environment,
    output,
    paths,
    prerequisiteCheck,
    status: async () => ({
      account: { planType: 'plus', type: 'chatgpt' },
      address: '127.0.0.1:47321',
      running: true,
      pairing: { paired: true, pending: false },
    }),
  }), 0);
  assert.match(output.data, /Authentication: chatgpt/u);
  assert.match(output.data, /Startup: disabled/u);
  assert.match(output.data, /On-demand connection: registered/u);
  assert.match(output.data, /Browser pairing: paired/u);

  assert.equal(await repairCommand({
    activation,
    environment,
    output,
    paths,
    prerequisiteCheck,
    start,
  }), 0);

  let repairPairingUrl = null;
  assert.equal(await pairCommand({
    beginPairing: async () => ({ expiresAt: Date.now() + 60_000, pairingCode: 'R'.repeat(43) }),
    browserOpen: async (url) => { repairPairingUrl = url; },
    environment,
    output,
    paths,
    start,
  }), 0);
  assert.equal(new URL(repairPairingUrl).hash.includes('R'.repeat(43)), true);
  let revoked = false;
  assert.equal(await revokeCommand({
    environment,
    output,
    paths,
    revoke: async () => { revoked = true; },
  }), 0);
  assert.equal(revoked, true);

  assert.equal(await uninstallCommand({
    activation,
    environment,
    output,
    paths,
    stop: async () => false,
  }), 0);
  assert.equal(await pathExists(paths.dataRoot), false);
  assert.equal(activationState, null);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});
