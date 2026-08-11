import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assertNoLinksInPath } from '../../src/lifecycle/filesystem.mjs';
import { assertPathInside, createLifecyclePaths, UnsupportedPlatformError } from '../../src/lifecycle/paths.mjs';

const createEnvironment = async () => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-path-test-'));
  const local = join(root, 'Local');
  const roaming = join(root, 'Roaming');
  await mkdir(local);
  await mkdir(roaming);
  return {
    environment: { ...process.env, APPDATA: roaming, LOCALAPPDATA: local },
    local,
    root,
  };
};

test('resolves every lifecycle file below fixed per-user boundaries', async (testContext) => {
  const setup = await createEnvironment();
  testContext.after(() => rm(setup.root, { force: true, recursive: true }));
  const paths = createLifecyclePaths({ environment: setup.environment, platform: 'win32' });

  assert.equal(paths.dataRoot.startsWith(setup.environment.LOCALAPPDATA), true);
  assert.equal(paths.startupFile.startsWith(setup.environment.APPDATA), true);
  assert.match(paths.startupFile, /Startup[\\/]Bookarium Codex Connector\.lnk$/u);
  assert.throws(() => assertPathInside(paths.dataRoot, join(paths.dataRoot, '..', 'victim')));
  assert.throws(() => createLifecyclePaths({ environment: setup.environment, platform: 'linux' }), UnsupportedPlatformError);
});
test('rejects filesystem links in an owned path before following them', async (testContext) => {
  const setup = await createEnvironment();
  testContext.after(() => rm(setup.root, { force: true, recursive: true }));
  const target = join(setup.root, 'target');
  const linkedParent = join(setup.local, 'Bookarium');
  await mkdir(target);
  await writeFile(join(target, 'sentinel.txt'), 'keep', 'utf8');
  try {
    await symlink(target, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EPERM') {
      testContext.skip('Creating a Windows junction is unavailable in this environment.');
      return;
    }
    throw error;
  }
  const candidate = join(linkedParent, 'Codex Connector');
  await assert.rejects(() => assertNoLinksInPath(setup.local, candidate), /link|junction/u);
  assert.equal(dirname(candidate), linkedParent);
});
