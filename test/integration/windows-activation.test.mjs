import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installPackage, readLifecycle } from '../../src/lifecycle/installation.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';
import {
  createProtocolHandler,
  protocolHandlerMatches,
  readProtocolHandler,
  removeProtocolHandler,
} from '../../src/lifecycle/activation/windows.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

test('creates, verifies, and narrowly removes an isolated per-user protocol handler', {
  skip: process.platform !== 'win32',
}, async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-activation-test-'));
  const environment = {
    ...process.env,
    APPDATA: join(root, 'Roaming'),
    BOOKARIUM_ACTIVATION_TEST_ID: randomBytes(6).toString('hex'),
    LOCALAPPDATA: join(root, 'Local'),
  };
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
  const paths = createLifecyclePaths({ environment, packageRoot, platform: 'win32' });
  await installPackage(paths);
  const lifecycle = await readLifecycle(paths);
  let expected = null;
  testContext.after(async () => {
    if (expected) await removeProtocolHandler(paths, expected, { environment }).catch(() => {});
    await rm(root, { force: true, recursive: true });
  });

  expected = await createProtocolHandler(paths, lifecycle, { environment });
  const actual = await readProtocolHandler(paths, { environment });
  assert.equal(protocolHandlerMatches(actual, expected), true);
  assert.match(actual.scheme, /^bookarium-codex-test-[a-f0-9]{12}$/u);
  assert.match(actual.uri, /^bookarium-codex-test-[a-f0-9]{12}:\/\/connect$/u);
  assert.match(actual.command, /start-managed$/u);
  assert.doesNotMatch(actual.command, /%1|Bearer|pairing|secret/iu);

  const upgraded = {
    ...lifecycle,
    activation: expected,
    nodePath: join(root, 'replacement-node.exe'),
  };
  const replacement = await createProtocolHandler(paths, upgraded, { environment });
  assert.notEqual(replacement.command, expected.command);
  expected = replacement;
  assert.equal(protocolHandlerMatches(await readProtocolHandler(paths, { environment }), expected), true);

  await assert.rejects(
    () => removeProtocolHandler(paths, { ...expected, command: 'different' }, { environment }),
    /ownership could not be verified/u,
  );
  assert.equal(protocolHandlerMatches(await readProtocolHandler(paths, { environment }), expected), true);
  assert.equal(await removeProtocolHandler(paths, expected, { environment }), true);
  expected = null;
  assert.equal(await readProtocolHandler(paths, { environment }), null);
});
