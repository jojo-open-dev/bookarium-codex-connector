import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  installCommand,
  repairCommand,
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
  const prerequisiteCheck = async () => ({ codexVersion: 'codex-cli test', nodeVersion: process.versions.node });
  const start = async () => ({ alreadyRunning: false });

  assert.equal(await installCommand(['--no-startup'], {
    environment,
    output,
    paths,
    prerequisiteCheck,
    start,
  }), 0);
  assert.equal(await pathExists(paths.dataRoot), true);
  assert.doesNotMatch(output.data, /[A-Za-z0-9_-]{43}/u);

  output.data = '';
  assert.equal(await statusCommand({
    environment,
    output,
    paths,
    prerequisiteCheck,
    status: async () => ({
      account: { planType: 'plus', type: 'chatgpt' },
      address: '127.0.0.1:47321',
      running: true,
    }),
  }), 0);
  assert.match(output.data, /Authentication: chatgpt/u);
  assert.match(output.data, /Startup: disabled/u);

  assert.equal(await repairCommand({
    environment,
    output,
    paths,
    prerequisiteCheck,
    start,
  }), 0);

  assert.equal(await uninstallCommand({
    environment,
    output,
    paths,
    stop: async () => false,
  }), 0);
  assert.equal(await pathExists(paths.dataRoot), false);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});
