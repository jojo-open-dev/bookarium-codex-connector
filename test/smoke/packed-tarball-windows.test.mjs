import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { pathExists } from '../../src/lifecycle/filesystem.mjs';

const enabled = process.platform === 'win32'
  && process.env.BOOKARIUM_PACKED_SMOKE === '1'
  && typeof process.env.BOOKARIUM_TARBALL_PATH === 'string';

const findNpxCli = () => {
  const candidates = [
    process.env.npm_execpath
      ? join(dirname(process.env.npm_execpath), 'npx-cli.js')
      : null,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].filter(Boolean);
  return candidates;
};

const run = (npxCli, tarball, args, environment) => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [
    npxCli,
    '--yes',
    `--package=${tarball}`,
    '--',
    'bookarium-codex-connector',
    ...args,
  ], {
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const chunks = [];
  let bytes = 0;
  let settled = false;
  const rejectOnce = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.kill();
    reject(error);
  };
  const timer = setTimeout(() => {
    rejectOnce(new Error('Packed npx smoke command timed out.'));
  }, 60_000);
  const collect = (chunk) => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > 128 * 1_024) {
      rejectOnce(new Error('Packed npx smoke output exceeded its limit.'));
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('error', () => rejectOnce(new Error('Packed npx smoke command could not start.')));
  child.once('exit', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const output = Buffer.concat(chunks).toString('utf8');
    if (code !== 0) {
      reject(new Error(`Packed npx smoke command failed: ${output.slice(0, 1_000)}`));
      return;
    }
    resolvePromise(output);
  });
});

test('installs the actual npm tarball through npx in an isolated Windows profile', {
  skip: !enabled,
}, async (testContext) => {
  const tarball = resolve(process.env.BOOKARIUM_TARBALL_PATH ?? '');
  assert.equal(isAbsolute(tarball), true);
  assert.equal(await pathExists(tarball), true);
  let npxCli = null;
  for (const candidate of findNpxCli()) {
    if (await pathExists(candidate)) {
      npxCli = candidate;
      break;
    }
  }
  assert.ok(npxCli, 'npm must expose npx-cli.js for the packed smoke test.');

  const root = await mkdtemp(join(tmpdir(), 'bookarium-packed-smoke-'));
  const fakeBin = join(root, 'fake-bin');
  const localAppData = join(root, 'Local');
  const roamingAppData = join(root, 'Roaming');
  const npmCache = join(root, 'npm-cache');
  const dataRoot = join(localAppData, 'Bookarium', 'Codex Connector');
  const startupFile = join(
    roamingAppData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'Bookarium Codex Connector.lnk',
  );
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
    mkdir(roamingAppData, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
  ]);
  await copyFile(process.execPath, join(fakeBin, 'explorer.exe'));
  const environment = {
    ...process.env,
    APPDATA: roamingAppData,
    BOOKARIUM_ACTIVATION_TEST_ID: randomBytes(6).toString('hex'),
    LOCALAPPDATA: localAppData,
    npm_config_cache: npmCache,
    Path: `${fakeBin};${process.env.Path ?? ''}`,
  };
  const invoke = (args) => run(npxCli, tarball, args, environment);
  testContext.after(async () => {
    if (await pathExists(dataRoot)) await invoke(['uninstall']).catch(() => {});
    const relation = relative(resolve(tmpdir()), resolve(root));
    if (!relation || relation === '..' || relation.startsWith('..\\')) {
      throw new Error('Packed smoke cleanup escaped the operating-system temporary directory.');
    }
    await rm(root, { force: true, recursive: true });
  });

  const output = [];
  output.push(await invoke(['install', '--allowed-origin', 'http://localhost:5173']));
  assert.equal(await pathExists(dataRoot), true);
  assert.equal(await pathExists(startupFile), false);
  output.push(await invoke(['status']));
  output.push(await invoke(['pair']));
  output.push(await invoke(['revoke']));
  output.push(await invoke(['uninstall']));
  assert.equal(await pathExists(dataRoot), false);
  assert.equal(await pathExists(startupFile), false);
  assert.match(output.join(''), /Authentication: chatgpt/u);
  assert.match(output.join(''), /On-demand connection: registered/u);
  assert.doesNotMatch(output.join(''), /\b[A-Za-z0-9_-]{43}\b/u);
});
