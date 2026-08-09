import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  installCommand,
  statusCommand,
  uninstallCommand,
} from '../../src/commands/lifecycle.mjs';
import { pathExists } from '../../src/lifecycle/filesystem.mjs';
import { createLifecyclePaths } from '../../src/lifecycle/paths.mjs';

const enabled = process.platform === 'win32' && process.env.BOOKARIUM_REAL_CODEX_SMOKE === '1';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = { data: '', write(value) { this.data += value; } };

test('installs, starts, inspects, stops, and uninstalls with the real local Codex CLI', {
  skip: !enabled,
}, async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-real-smoke-'));
  const environment = {
    ...process.env,
    APPDATA: join(root, 'Roaming'),
    BOOKARIUM_ACTIVATION_TEST_ID: randomBytes(6).toString('hex'),
    LOCALAPPDATA: join(root, 'Local'),
  };
  await mkdir(environment.APPDATA, { recursive: true });
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
  const paths = createLifecyclePaths({ environment, packageRoot, platform: 'win32' });
  testContext.after(async () => {
    if (await pathExists(paths.dataRoot)) {
      await uninstallCommand({ environment, output, paths }).catch(() => {});
    }
    await rm(root, { force: true, recursive: true });
  });

  assert.equal(await installCommand([
    '--allowed-origin',
    'http://localhost:5173',
    '--no-startup',
  ], { browserOpen: async () => {}, environment, output, paths }), 0);
  assert.equal(await statusCommand({ environment, output, paths }), 0);
  assert.match(output.data, /Process: running/u);
  assert.match(output.data, /Authentication: chatgpt/u);
  assert.equal(await uninstallCommand({ environment, output, paths }), 0);
  assert.equal(await pathExists(paths.dataRoot), false);
});
