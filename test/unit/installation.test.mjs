import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { pathExists } from '../../src/lifecycle/filesystem.mjs';
import {
  installPackage,
  readConnectorConfig,
  readLifecycle,
  verifyInstalledVersion,
} from '../../src/lifecycle/installation.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';
import { createPairingAuthority } from '../../src/lifecycle/pairing-state.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

const setupInstallation = async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-install-test-'));
  const environment = {
    ...process.env,
    APPDATA: join(root, 'Roaming'),
    LOCALAPPDATA: join(root, 'Local'),
  };
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
  const paths = createLifecyclePaths({ environment, packageRoot, platform: 'win32' });
  testContext.after(() => rm(root, { force: true, recursive: true }));
  return { environment, paths, root };
};

test('installs only reviewed files with a verifiable manifest and private state', async (testContext) => {
  const { paths } = await setupInstallation(testContext);
  await installPackage(paths, { allowedOrigin: 'https://bienemaja.app' });

  const manifest = await verifyInstalledVersion(paths);
  assert.equal(manifest.packageName, '@bookarium/codex-connector');
  assert.equal(Object.hasOwn(manifest.files, 'src/lifecycle/installation.mjs'), true);
  assert.equal(Object.hasOwn(manifest.files, 'test/unit/installation.test.mjs'), false);
  const config = await readConnectorConfig(paths);
  assert.equal(config.allowedOrigin, 'https://bienemaja.app');
  assert.equal(Object.hasOwn(config, 'pairingToken'), false);
  assert.equal(config.controlSecret.length, 43);
  const pairingState = await readFile(paths.pairingFile, 'utf8');
  assert.doesNotMatch(pairingState, /[A-Za-z0-9_-]{43}/u);
  const lifecycle = await readLifecycle(paths);
  assert.equal(lifecycle.startupEnabled, false);
  assert.equal(lifecycle.activation, null);
  assert.equal(lifecycle.codexCommand, process.execPath);
  assert.deepEqual(lifecycle.codexArgsPrefix, []);
  assert.equal(lifecycle.schemaVersion, 2);
  assert.equal(await pathExists(paths.installedBinary), true);
});
test('detects installed file changes and unexpected files', async (testContext) => {
  const { paths } = await setupInstallation(testContext);
  await installPackage(paths);
  await writeFile(paths.installedBinary, 'tampered', 'utf8');
  await assert.rejects(() => verifyInstalledVersion(paths), /integrity/u);

  await rm(paths.versionRoot, { force: true, recursive: true });
  await installPackage(paths);
  await writeFile(join(paths.versionRoot, 'unexpected.txt'), 'unexpected', 'utf8');
  await assert.rejects(() => verifyInstalledVersion(paths), /file set/u);
});

test('refuses to claim a nonempty directory without the ownership marker', async (testContext) => {
  const { paths } = await setupInstallation(testContext);
  await mkdir(paths.dataRoot, { recursive: true });
  const sentinel = join(paths.dataRoot, 'unrelated.txt');
  await writeFile(sentinel, 'keep', 'utf8');
  await assert.rejects(() => installPackage(paths), /without an ownership marker/u);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('migrates a legacy plaintext browser token to a verifier without changing access', async (testContext) => {
  const { paths } = await setupInstallation(testContext);
  await installPackage(paths, { startupEnabled: false });
  const config = await readConnectorConfig(paths);
  const legacyToken = 'L'.repeat(43);
  await rm(paths.pairingFile);
  await writeFile(paths.configFile, `${JSON.stringify({
    ...config,
    pairingToken: legacyToken,
    schemaVersion: 1,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  await installPackage(paths, { startupEnabled: false });
  const migrated = await readConnectorConfig(paths);
  assert.equal(Object.hasOwn(migrated, 'pairingToken'), false);
  const authority = createPairingAuthority(paths, {
    allowedOrigin: migrated.allowedOrigin,
    installationId: migrated.installationId,
  });
  assert.equal(await authority.authenticate(legacyToken), true);
  assert.equal((await readFile(paths.configFile, 'utf8')).includes(legacyToken), false);
  assert.equal((await readFile(paths.pairingFile, 'utf8')).includes(legacyToken), false);
});
