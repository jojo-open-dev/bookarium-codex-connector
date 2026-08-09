import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from '../../src/cli.mjs';

const capture = () => ({
  data: '',
  write(value) { this.data += value; },
});

test('prints version and help without starting the connector', async () => {
  const stdout = capture();
  let started = false;
  assert.equal(await runCli(['--version'], {
    startServer: async () => { started = true; },
    stdout,
  }), 0);
  assert.match(stdout.data, /0\.1\.0.*protocol 1/u);
  assert.equal(started, false);

  stdout.data = '';
  assert.equal(await runCli(['--help'], { stdout }), 0);
  assert.match(stdout.data, /Usage:/u);
});

test('reserved and unknown commands return useful nonzero exit codes', async () => {
  const stderr = capture();
  assert.equal(await runCli(['install'], { stderr }), 2);
  assert.match(stderr.data, /intentionally unavailable.*no system changes/u);

  stderr.data = '';
  assert.equal(await runCli(['arbitrary'], { stderr }), 2);
  assert.match(stderr.data, /Unknown command/u);
});
