import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProcess } from '../../src/lifecycle/subprocess.mjs';

test('runs a bounded child without a shell and captures output', async () => {
  const result = await runProcess({
    args: ['-e', 'process.stdout.write("safe stdout"); process.stderr.write("safe stderr")'],
    command: process.execPath,
  });
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'safe stdout');
  assert.equal(result.stderr, 'safe stderr');
});

test('terminates children that exceed output or time limits', async () => {
  await assert.rejects(runProcess({
    args: ['-e', 'process.stdout.write("x".repeat(128))'],
    command: process.execPath,
    maximumOutputBytes: 16,
  }), /output exceeded its limit/u);

  await assert.rejects(runProcess({
    args: ['-e', 'setInterval(() => {}, 1_000)'],
    command: process.execPath,
    timeoutMs: 50,
  }), /timed out/u);
});

test('normalizes synchronous spawn failures', async () => {
  await assert.rejects(runProcess({
    command: 'never-run',
    spawnProcess: () => { throw new Error('sensitive process detail'); },
  }), /Required process could not be started/u);
});
