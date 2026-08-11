import { spawn } from 'node:child_process';

export const runProcess = ({
  args = [],
  command,
  cwd,
  environment = process.env,
  maximumOutputBytes = 64 * 1_024,
  spawnProcess = spawn,
  timeoutMs = 10_000,
} = {}) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawnProcess(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    reject(new Error('Required process could not be started.'));
    return;
  }

  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let settled = false;
  let timer = null;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(value);
  };
  const collect = (destination) => (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) {
      child.kill();
      finish(reject, new Error('Child process output exceeded its limit.'));
      return;
    }
    destination.push(chunk);
  };

  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.once('error', () => finish(reject, new Error('Required process could not be started.')));
  child.once('exit', (code, signal) => finish(resolve, {
    code,
    signal,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  }));

  timer = setTimeout(() => {
    child.kill();
    finish(reject, new Error('Child process timed out.'));
  }, timeoutMs);
  timer.unref?.();
});
