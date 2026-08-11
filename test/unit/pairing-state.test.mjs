import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PAIRING_REQUEST_TTL_MS } from '../../src/constants.mjs';
import { installPackage, readConnectorConfig } from '../../src/lifecycle/installation.mjs';
import { createPairingAuthority } from '../../src/lifecycle/pairing-state.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

const setup = async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-pairing-test-'));
  const environment = {
    ...process.env,
    APPDATA: join(root, 'Roaming'),
    LOCALAPPDATA: join(root, 'Local'),
  };
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
  const paths = createLifecyclePaths({ environment, packageRoot, platform: 'win32' });
  await installPackage(paths, { allowedOrigin: 'https://bienemaja.app', startupEnabled: false });
  const config = await readConnectorConfig(paths);
  testContext.after(() => rm(root, { force: true, recursive: true }));
  return { config, paths };
};

const deterministicRandom = () => {
  let fill = 1;
  return (bytes) => Buffer.alloc(bytes, fill++);
};

test('exchanges a short-lived request once without persisting either plaintext token', async (testContext) => {
  const { config, paths } = await setup(testContext);
  let now = 1_700_000_000_000;
  const authority = createPairingAuthority(paths, {
    allowedOrigin: config.allowedOrigin,
    clock: () => now,
    installationId: config.installationId,
    random: deterministicRandom(),
  });

  const { expiresAt, pairingCode } = await authority.issue();
  assert.equal(expiresAt, now + PAIRING_REQUEST_TTL_MS);
  assert.equal(await authority.exchange('malformed'), null);
  const token = await authority.exchange(pairingCode);
  assert.equal(token?.length, 43);
  assert.equal(await authority.exchange(pairingCode), null);
  assert.equal(await authority.authenticate(token), true);
  assert.equal(await authority.authenticate('Z'.repeat(43)), false);
  assert.deepEqual(await authority.status(), { paired: true, pending: false });

  const persisted = await readFile(paths.pairingFile, 'utf8');
  assert.equal(persisted.includes(pairingCode), false);
  assert.equal(persisted.includes(token), false);
  now += 1;
});

test('expires unused requests and permits only one winner under replay', async (testContext) => {
  const { config, paths } = await setup(testContext);
  let now = 1_700_000_000_000;
  const authority = createPairingAuthority(paths, {
    allowedOrigin: config.allowedOrigin,
    clock: () => now,
    installationId: config.installationId,
    random: deterministicRandom(),
  });

  const expired = await authority.issue();
  now = expired.expiresAt;
  assert.equal(await authority.exchange(expired.pairingCode), null);
  assert.deepEqual(await authority.status(), { paired: false, pending: false });

  now += 1;
  const active = await authority.issue();
  const results = await Promise.all([
    authority.exchange(active.pairingCode),
    authority.exchange(active.pairingCode),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test('keeps existing access during pending rotation, then replaces and revokes it', async (testContext) => {
  const { config, paths } = await setup(testContext);
  let now = 1_700_000_000_000;
  const authority = createPairingAuthority(paths, {
    allowedOrigin: config.allowedOrigin,
    clock: () => now,
    installationId: config.installationId,
    random: deterministicRandom(),
  });

  const firstRequest = await authority.issue();
  const firstToken = await authority.exchange(firstRequest.pairingCode);
  now += 1;
  const rotation = await authority.issue();
  assert.equal(await authority.authenticate(firstToken), true);
  const secondToken = await authority.exchange(rotation.pairingCode);
  assert.equal(await authority.authenticate(firstToken), false);
  assert.equal(await authority.authenticate(secondToken), true);

  await authority.revoke();
  assert.equal(await authority.authenticate(secondToken), false);
  assert.deepEqual(await authority.status(), { paired: false, pending: false });
});
