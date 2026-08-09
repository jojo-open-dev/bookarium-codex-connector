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

export const checkPrerequisites = async ({
  codexCommand = 'codex',
  environment = process.env,
  nodeVersion = process.versions.node,
  run = runProcess,
} = {}) => {
  const parsedNode = parseNodeVersion(nodeVersion);
  if (parsedNode.some((value) => !Number.isInteger(value)) || !meetsMinimum(parsedNode, MINIMUM_NODE)) {
    throw new Error('Node.js 20.18.1 or newer is required. Install it and try again.');
  }

  let result;
  try {
    result = await run({
      args: ['--version'],
      command: codexCommand,
      environment,
      timeoutMs: 10_000,
    });
  } catch {
    throw new Error('The official Codex CLI was not found. Install Codex and sign in with ChatGPT first.');
  }
  const version = result.stdout.trim();
  if (result.code !== 0 || !/^codex-cli\s+\S+$/u.test(version)) {
    throw new Error('The official Codex CLI is unavailable. Install Codex and sign in with ChatGPT first.');
  }
  return { codexVersion: version, nodeVersion };
};
