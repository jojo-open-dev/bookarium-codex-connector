import { lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { runProcess } from './subprocess.mjs';

const MINIMUM_NODE = [20, 18, 1];

const parseNodeVersion = (version) => version.split('.').map((part) => Number(part));
const meetsMinimum = (actual, minimum) => {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] ?? 0) > minimum[index]) return true;
    if ((actual[index] ?? 0) < minimum[index]) return false;
  }
  return true;
};

const existingFile = async (path) => {
  try {
    const resolvedPath = await realpath(path);
    const stats = await lstat(resolvedPath);
    return stats.isFile() ? resolvedPath : null;
  } catch {
    return null;
  }
};

const pathValue = (environment) => Object.entries(environment)
  .find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';

export const discoverCodexLaunches = async ({
  environment = process.env,
  nodePath = process.execPath,
  platform = process.platform,
} = {}) => {
  const directories = pathValue(environment)
    .split(platform === 'win32' ? ';' : delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ''))
    .filter((entry) => entry && isAbsolute(entry));
  if (platform === 'win32' && isAbsolute(environment.APPDATA ?? '')) {
    directories.push(join(environment.APPDATA, 'npm'));
  }

  const launches = [];
  const seen = new Set();
  const add = async (commandPath, codexArgsPrefix = []) => {
    const command = await existingFile(commandPath);
    if (!command) return;
    const resolvedPrefix = [];
    for (const argument of codexArgsPrefix) {
      const path = await existingFile(argument);
      if (!path) return;
      resolvedPrefix.push(path);
    }
    const key = JSON.stringify([command, resolvedPrefix]);
    if (seen.has(key)) return;
    seen.add(key);
    launches.push({ codexArgsPrefix: resolvedPrefix, codexCommand: command });
  };

  for (const directory of directories) {
    if (platform === 'win32') {
      await add(join(directory, 'codex.exe'));
      await add(resolve(nodePath), [join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]);
    } else {
      await add(join(directory, 'codex'));
    }
  }
  return launches;
};

export const checkPrerequisites = async ({
  codexArgsPrefix = [],
  codexCommand = null,
  discover = discoverCodexLaunches,
  environment = process.env,
  nodePath = process.execPath,
  nodeVersion = process.versions.node,
  run = runProcess,
} = {}) => {
  const parsedNode = parseNodeVersion(nodeVersion);
  if (parsedNode.some((value) => !Number.isInteger(value)) || !meetsMinimum(parsedNode, MINIMUM_NODE)) {
    throw new Error('Node.js 20.18.1 or newer is required. Install it and try again.');
  }

  const launches = codexCommand
    ? [{ codexArgsPrefix, codexCommand }]
    : await discover({ environment, nodePath });
  let found = false;
  for (const launch of launches) {
    let result;
    try {
      result = await run({
        args: [...launch.codexArgsPrefix, '--version'],
        command: launch.codexCommand,
        environment,
        timeoutMs: 10_000,
      });
    } catch {
      continue;
    }
    found = true;
    const version = result.stdout.trim();
    if (result.code === 0 && /^codex-cli\s+\S+$/u.test(version)) {
      return {
        codexArgsPrefix: [...launch.codexArgsPrefix],
        codexCommand: launch.codexCommand,
        codexVersion: version,
        nodeVersion,
      };
    }
  }
  if (!found) {
    throw new Error('The official Codex CLI was not found. Install Codex and sign in with ChatGPT first.');
  }
  throw new Error('The official Codex CLI is unavailable. Install Codex and sign in with ChatGPT first.');
};
