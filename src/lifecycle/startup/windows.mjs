import { lstat, mkdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { assertNoLinksInPath, pathExists } from '../filesystem.mjs';
import { runProcess } from '../subprocess.mjs';

const DESCRIPTION = 'Bookarium Codex Connector (per-user startup)';

const CREATE_SHORTCUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:BOOKARIUM_SHORTCUT_PATH)
$shortcut.TargetPath = $env:BOOKARIUM_SHORTCUT_TARGET
$shortcut.Arguments = $env:BOOKARIUM_SHORTCUT_ARGUMENTS
$shortcut.WorkingDirectory = $env:BOOKARIUM_SHORTCUT_WORKING_DIRECTORY
$shortcut.Description = $env:BOOKARIUM_SHORTCUT_DESCRIPTION
$shortcut.WindowStyle = 7
$shortcut.Save()
`;

const READ_SHORTCUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:BOOKARIUM_SHORTCUT_PATH)
$value = [ordered]@{
  target = $shortcut.TargetPath
  arguments = $shortcut.Arguments
  workingDirectory = $shortcut.WorkingDirectory
  description = $shortcut.Description
  windowStyle = $shortcut.WindowStyle
}
[Console]::Out.Write(($value | ConvertTo-Json -Compress))
`;

const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

export const quoteWindowsArgument = (value) => {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid Windows argument.');
  let output = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
    } else if (character === '"') {
      output += '\\'.repeat((backslashes * 2) + 1);
      output += '"';
      backslashes = 0;
    } else {
      output += '\\'.repeat(backslashes);
      output += character;
      backslashes = 0;
    }
  }
  output += '\\'.repeat(backslashes * 2);
  return `${output}"`;
};

const getPowerShellPath = (environment) => {
  const windowsRoot = environment.SystemRoot ?? environment.WINDIR;
  if (typeof windowsRoot !== 'string' || !isAbsolute(windowsRoot)) {
    throw new Error('Windows system directory is unavailable.');
  }
  return join(resolve(windowsRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
};

const runShortcutPowerShell = async (script, shortcutEnvironment, {
  environment = process.env,
  run = runProcess,
} = {}) => {
  const result = await run({
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
    command: getPowerShellPath(environment),
    environment: { ...environment, ...shortcutEnvironment },
    timeoutMs: 10_000,
  });
  if (result.code !== 0) throw new Error('Windows could not manage the connector startup shortcut.');
  return result.stdout;
};

export const expectedStartupShortcut = (paths, lifecycle) => ({
  arguments: `${quoteWindowsArgument(paths.installedBinary)} start-managed`,
  description: DESCRIPTION,
  path: paths.startupFile,
  target: resolve(lifecycle.nodePath),
  windowStyle: 7,
  workingDirectory: paths.versionRoot,
});

export const readStartupShortcut = async (paths, options = {}) => {
  if (!await pathExists(paths.startupFile)) return null;
  await assertNoLinksInPath(paths.roamingAppData, paths.startupFile);
  const stats = await lstat(paths.startupFile);
  if (!stats.isFile() || stats.size > 1_024 * 1_024) throw new Error('Startup entry is not a normal shortcut file.');
  const output = await runShortcutPowerShell(READ_SHORTCUT_SCRIPT, {
    BOOKARIUM_SHORTCUT_PATH: paths.startupFile,
  }, options);
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Windows returned invalid startup shortcut metadata.');
  }
  if (!value || typeof value !== 'object') throw new Error('Startup shortcut metadata is invalid.');
  return { path: paths.startupFile, ...value };
};

export const startupShortcutMatches = (actual, expected) => Boolean(actual
  && resolve(actual.target) === resolve(expected.target)
  && actual.arguments === expected.arguments
  && resolve(actual.workingDirectory) === resolve(expected.workingDirectory)
  && actual.description === expected.description
  && Number(actual.windowStyle) === expected.windowStyle);

export const createStartupShortcut = async (paths, lifecycle, options = {}) => {
  await assertNoLinksInPath(paths.roamingAppData, paths.startupFolder, { includeLeaf: false });
  await mkdir(paths.startupFolder, { recursive: true });
  await assertNoLinksInPath(paths.roamingAppData, paths.startupFolder);
  const expected = expectedStartupShortcut(paths, lifecycle);
  const existing = await readStartupShortcut(paths, options);
  if (existing) {
    if (!startupShortcutMatches(existing, expected)) {
      throw new Error('A different startup entry already uses the Bookarium connector name.');
    }
    return expected;
  }

  await runShortcutPowerShell(CREATE_SHORTCUT_SCRIPT, {
    BOOKARIUM_SHORTCUT_ARGUMENTS: expected.arguments,
    BOOKARIUM_SHORTCUT_DESCRIPTION: expected.description,
    BOOKARIUM_SHORTCUT_PATH: expected.path,
    BOOKARIUM_SHORTCUT_TARGET: expected.target,
    BOOKARIUM_SHORTCUT_WORKING_DIRECTORY: expected.workingDirectory,
  }, options);
  const created = await readStartupShortcut(paths, options);
  if (!startupShortcutMatches(created, expected)) {
    throw new Error('Windows startup shortcut verification failed.');
  }
  return expected;
};

export const removeStartupShortcut = async (paths, expected, options = {}) => {
  const actual = await readStartupShortcut(paths, options);
  if (!actual) return false;
  if (!expected || !startupShortcutMatches(actual, expected)) {
    throw new Error('Startup shortcut ownership could not be verified; it was not removed.');
  }
  await assertNoLinksInPath(paths.roamingAppData, paths.startupFile);
  await unlink(paths.startupFile);
  return true;
};
