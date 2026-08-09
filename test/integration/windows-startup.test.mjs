import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { pathExists } from '../../src/lifecycle/filesystem.mjs';
import { installPackage, readLifecycle } from '../../src/lifecycle/installation.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';
import {
  createStartupShortcut,
  readStartupShortcut,
  removeStartupShortcut,
  startupShortcutMatches,
} from '../../src/lifecycle/startup/windows.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

test('creates, reads back, and narrowly removes an isolated per-user Windows shortcut', {
  skip: process.platform !== 'win32',
}, async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-shortcut-test-'));
  const environment = {
    ...process.env,
    APPDATA: join(root, 'Roaming'),
    LOCALAPPDATA: join(root, 'Local'),
  };
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
  const paths = createLifecyclePaths({ environment, packageRoot, platform: 'win32' });
  await installPackage(paths);
  const lifecycle = await readLifecycle(paths);
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const expected = await createStartupShortcut(paths, lifecycle, { environment });
  const actual = await readStartupShortcut(paths, { environment });
  assert.equal(startupShortcutMatches(actual, expected), true);
  assert.doesNotMatch(actual.arguments, /Bearer|pairing|secret/iu);

  await assert.rejects(
    () => removeStartupShortcut(paths, { ...expected, arguments: 'different' }, { environment }),
    /ownership could not be verified/u,
  );
  assert.equal(await pathExists(paths.startupFile), true);
  assert.equal(await removeStartupShortcut(paths, expected, { environment }), true);
  assert.equal(await pathExists(paths.startupFile), false);
});
