import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkPrerequisites,
  discoverCodexLaunches,
} from '../../src/lifecycle/prerequisites.mjs';

test('accepts the minimum supported Node version and official Codex version shape', async () => {
  const environment = { TEST_SENTINEL: 'present' };
  const launch = {
    codexArgsPrefix: ['C:\\tools\\codex.js'],
    codexCommand: 'C:\\tools\\node.exe',
  };
  const run = async (options) => {
    assert.equal(options.command, launch.codexCommand);
    assert.deepEqual(options.args, [...launch.codexArgsPrefix, '--version']);
    assert.equal(options.environment, environment);
    assert.equal(options.timeoutMs, 10_000);
    return { code: 0, stdout: 'codex-cli 0.147.0\n' };
  };
  assert.deepEqual(await checkPrerequisites({
    discover: async () => [launch],
    environment,
    nodeVersion: '20.18.1',
    run,
  }), {
    ...launch,
    codexVersion: 'codex-cli 0.147.0',
    nodeVersion: '20.18.1',
  });
});

test('discovers the stable npm Codex launcher outside the inherited PATH', async (testContext) => {
  const root = await mkdtemp(join(tmpdir(), 'bookarium-codex-discovery-test-'));
  const appData = join(root, 'Roaming');
  const launcher = join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await mkdir(join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  await writeFile(launcher, "console.log('codex-cli test');\n", 'utf8');
  testContext.after(() => rm(root, { force: true, recursive: true }));

  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'),
  );
  environment.APPDATA = appData;
  environment.PATH = 'C:\\unrelated';

  const launches = await discoverCodexLaunches({
    environment,
    nodePath: process.execPath,
    platform: 'win32',
  });

  assert.deepEqual(launches, [{
    codexArgsPrefix: [launcher],
    codexCommand: await realpath(process.execPath),
  }]);
  assert.deepEqual(await checkPrerequisites({ environment }), {
    codexArgsPrefix: [launcher],
    codexCommand: await realpath(process.execPath),
    codexVersion: 'codex-cli test',
    nodeVersion: process.versions.node,
  });
});

test('rejects old or malformed Node versions before starting Codex', async () => {
  let calls = 0;
  const run = async () => { calls += 1; };
  await assert.rejects(
    checkPrerequisites({ nodeVersion: '20.18.0', run }),
    /Node\.js 20\.18\.1 or newer/u,
  );
  await assert.rejects(
    checkPrerequisites({ nodeVersion: 'not-a-version', run }),
    /Node\.js 20\.18\.1 or newer/u,
  );
  assert.equal(calls, 0);
});

test('reports missing, failing, and unrecognized Codex executables safely', async () => {
  const launch = { codexArgsPrefix: [], codexCommand: process.execPath };
  await assert.rejects(
    checkPrerequisites({ discover: async () => [launch], run: async () => { throw new Error('sensitive detail'); } }),
    /official Codex CLI was not found/u,
  );
  await assert.rejects(
    checkPrerequisites({ discover: async () => [launch], run: async () => ({ code: 1, stdout: '' }) }),
    /official Codex CLI is unavailable/u,
  );
  await assert.rejects(
    checkPrerequisites({ discover: async () => [launch], run: async () => ({ code: 0, stdout: 'unexpected tool 1.0' }) }),
    /official Codex CLI is unavailable/u,
  );
});
