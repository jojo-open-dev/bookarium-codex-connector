import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPrerequisites } from '../../src/lifecycle/prerequisites.mjs';

test('accepts the minimum supported Node version and official Codex version shape', async () => {
  const environment = { TEST_SENTINEL: 'present' };
  const run = async (options) => {
    assert.equal(options.command, 'codex');
    assert.deepEqual(options.args, ['--version']);
    assert.equal(options.environment, environment);
    assert.equal(options.timeoutMs, 10_000);
    return { code: 0, stdout: 'codex-cli 0.147.0\n' };
  };
  assert.deepEqual(await checkPrerequisites({
    environment,
    nodeVersion: '20.18.1',
    run,
  }), {
    codexVersion: 'codex-cli 0.147.0',
    nodeVersion: '20.18.1',
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
  await assert.rejects(
    checkPrerequisites({ run: async () => { throw new Error('sensitive detail'); } }),
    /official Codex CLI was not found/u,
  );
  await assert.rejects(
    checkPrerequisites({ run: async () => ({ code: 1, stdout: '' }) }),
    /official Codex CLI is unavailable/u,
  );
  await assert.rejects(
    checkPrerequisites({ run: async () => ({ code: 0, stdout: 'unexpected tool 1.0' }) }),
    /official Codex CLI is unavailable/u,
  );
});
