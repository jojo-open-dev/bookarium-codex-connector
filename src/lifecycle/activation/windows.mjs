import { isAbsolute, join, resolve } from 'node:path';
import { quoteWindowsArgument } from '../startup/windows.mjs';
import { runProcess } from '../subprocess.mjs';

const DESCRIPTION = 'URL:Bookarium Codex Connector';
const EXPECTED_SHAPE = Object.freeze({
  commandSubKeyNames: [],
  commandValueNames: [''],
  openSubKeyNames: ['command'],
  openValueNames: [],
  rootSubKeyNames: ['shell'],
  rootValueNames: ['', 'URL Protocol'],
  shellSubKeyNames: ['open'],
  shellValueNames: [],
});
const STRING_VALUE_KIND = 'String';

const READ_PROTOCOL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:BOOKARIUM_PROTOCOL_REGISTRY_PATH
$root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)
if ($null -eq $root) {
  [Console]::Out.Write('null')
  exit 0
}
$shell = $null
$open = $null
$command = $null
try {
  $shell = $root.OpenSubKey('shell', $false)
  if ($null -ne $shell) { $open = $shell.OpenSubKey('open', $false) }
  if ($null -ne $open) { $command = $open.OpenSubKey('command', $false) }
  $value = [ordered]@{
    command = if ($null -eq $command) { $null } else { $command.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    commandKind = if ($null -eq $command) { $null } else { [string]$command.GetValueKind('') }
    commandSubKeyNames = @($(if ($null -ne $command) { $command.GetSubKeyNames() | Sort-Object -CaseSensitive }))
    commandValueNames = @($(if ($null -ne $command) { $command.GetValueNames() | Sort-Object -CaseSensitive }))
    description = $root.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    descriptionKind = [string]$root.GetValueKind('')
    openSubKeyNames = @($(if ($null -ne $open) { $open.GetSubKeyNames() | Sort-Object -CaseSensitive }))
    openValueNames = @($(if ($null -ne $open) { $open.GetValueNames() | Sort-Object -CaseSensitive }))
    registryPath = $path
    rootSubKeyNames = @($root.GetSubKeyNames() | Sort-Object -CaseSensitive)
    rootValueNames = @($root.GetValueNames() | Sort-Object -CaseSensitive)
    shellSubKeyNames = @($(if ($null -ne $shell) { $shell.GetSubKeyNames() | Sort-Object -CaseSensitive }))
    shellValueNames = @($(if ($null -ne $shell) { $shell.GetValueNames() | Sort-Object -CaseSensitive }))
    urlProtocol = $root.GetValue('URL Protocol', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    urlProtocolKind = [string]$root.GetValueKind('URL Protocol')
  }
  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 3))
} finally {
  if ($null -ne $command) { $command.Dispose() }
  if ($null -ne $open) { $open.Dispose() }
  if ($null -ne $shell) { $shell.Dispose() }
  $root.Dispose()
}
`;

const CREATE_PROTOCOL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:BOOKARIUM_PROTOCOL_REGISTRY_PATH
$existing = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)
if ($null -ne $existing) {
  $existing.Dispose()
  throw 'Protocol registration already exists.'
}
$root = $null
$shell = $null
$open = $null
$command = $null
try {
  $root = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
  $root.SetValue('', $env:BOOKARIUM_PROTOCOL_DESCRIPTION, [Microsoft.Win32.RegistryValueKind]::String)
  $root.SetValue('URL Protocol', '', [Microsoft.Win32.RegistryValueKind]::String)
  $shell = $root.CreateSubKey('shell')
  $open = $shell.CreateSubKey('open')
  $command = $open.CreateSubKey('command')
  $command.SetValue('', $env:BOOKARIUM_PROTOCOL_COMMAND, [Microsoft.Win32.RegistryValueKind]::String)
} finally {
  if ($null -ne $command) { $command.Dispose() }
  if ($null -ne $open) { $open.Dispose() }
  if ($null -ne $shell) { $shell.Dispose() }
  if ($null -ne $root) { $root.Dispose() }
}
`;

const REMOVE_PROTOCOL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Test-ExactNames($actual, $expected) {
  $left = @($actual | Sort-Object -CaseSensitive)
  $right = @($expected | Sort-Object -CaseSensitive)
  if ($left.Count -ne $right.Count) { return $false }
  for ($index = 0; $index -lt $left.Count; $index += 1) {
    if (-not ($left[$index] -ceq $right[$index])) { return $false }
  }
  return $true
}
$path = $env:BOOKARIUM_PROTOCOL_REGISTRY_PATH
$root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)
if ($null -eq $root) { exit 0 }
$shell = $null
$open = $null
$command = $null
$matches = $false
try {
  $shell = $root.OpenSubKey('shell', $false)
  if ($null -ne $shell) { $open = $shell.OpenSubKey('open', $false) }
  if ($null -ne $open) { $command = $open.OpenSubKey('command', $false) }
  $matches = $null -ne $command
  if ($matches) { $matches = $matches -and (Test-ExactNames ($root.GetValueNames()) @('', 'URL Protocol')) }
  if ($matches) { $matches = $matches -and (Test-ExactNames ($root.GetSubKeyNames()) @('shell')) }
  if ($matches) { $matches = $matches -and (Test-ExactNames ($shell.GetValueNames()) @()) }
  if ($matches) { $matches = $matches -and (Test-ExactNames ($shell.GetSubKeyNames()) @('open')) }
  if ($matches) { $matches = $matches -and (Test-ExactNames ($open.GetValueNames()) @()) }
  if ($matches) { $matches = $matches -and (Test-ExactNames ($open.GetSubKeyNames()) @('command')) }
  if ($matches) { $matches = $matches -and (Test-ExactNames ($command.GetValueNames()) @('')) }
  if ($matches) { $matches = $matches -and (Test-ExactNames ($command.GetSubKeyNames()) @()) }
  if ($matches) { $matches = $matches -and ($root.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ceq $env:BOOKARIUM_PROTOCOL_DESCRIPTION) }
  if ($matches) { $matches = $matches -and ([string]$root.GetValueKind('') -ceq 'String') }
  if ($matches) { $matches = $matches -and ($root.GetValue('URL Protocol', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ceq '') }
  if ($matches) { $matches = $matches -and ([string]$root.GetValueKind('URL Protocol') -ceq 'String') }
  if ($matches) { $matches = $matches -and ($command.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ceq $env:BOOKARIUM_PROTOCOL_COMMAND) }
  if ($matches) { $matches = $matches -and ([string]$command.GetValueKind('') -ceq 'String') }
} finally {
  if ($null -ne $command) { $command.Dispose() }
  if ($null -ne $open) { $open.Dispose() }
  if ($null -ne $shell) { $shell.Dispose() }
  $root.Dispose()
}
if (-not $matches) { throw 'Protocol registration ownership could not be verified.' }
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($path, $false)
`;

const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

const getPowerShellPath = (environment) => {
  const windowsRoot = environment.SystemRoot ?? environment.WINDIR;
  if (typeof windowsRoot !== 'string' || !isAbsolute(windowsRoot)) {
    throw new Error('Windows system directory is unavailable.');
  }
  return join(resolve(windowsRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
};

const runProtocolPowerShell = async (script, handlerEnvironment, {
  environment = process.env,
  run = runProcess,
} = {}) => {
  const result = await run({
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
    command: getPowerShellPath(environment),
    environment: { ...environment, ...handlerEnvironment },
    timeoutMs: 10_000,
  });
  if (result.code !== 0) throw new Error('Windows could not manage on-demand connector activation.');
  return result.stdout;
};

const normalizeNames = (value) => {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
};

export const expectedProtocolHandler = (paths, lifecycle) => ({
  command: `${quoteWindowsArgument(resolve(lifecycle.nodePath))} ${quoteWindowsArgument(paths.installedBinary)} start-managed`,
  description: DESCRIPTION,
  registryPath: paths.activationRegistryPath,
  scheme: paths.activationScheme,
  uri: paths.activationUri,
});

export const readProtocolHandler = async (paths, options = {}) => {
  const output = await runProtocolPowerShell(READ_PROTOCOL_SCRIPT, {
    BOOKARIUM_PROTOCOL_REGISTRY_PATH: paths.activationRegistryPath,
  }, options);
  if (output === 'null') return null;
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('Windows returned invalid connector activation metadata.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Windows returned invalid connector activation metadata.');
  }
  for (const name of Object.keys(EXPECTED_SHAPE)) value[name] = normalizeNames(value[name]);
  return {
    ...value,
    scheme: paths.activationScheme,
    uri: paths.activationUri,
  };
};

export const protocolHandlerMatches = (actual, expected) => Boolean(actual
  && expected
  && actual.command === expected.command
  && actual.commandKind === STRING_VALUE_KIND
  && actual.description === expected.description
  && actual.descriptionKind === STRING_VALUE_KIND
  && actual.registryPath === expected.registryPath
  && actual.scheme === expected.scheme
  && actual.uri === expected.uri
  && actual.urlProtocol === ''
  && actual.urlProtocolKind === STRING_VALUE_KIND
  && Object.entries(EXPECTED_SHAPE).every(([name, names]) => (
    JSON.stringify(actual[name]) === JSON.stringify(names)
  )));

export const createProtocolHandler = async (paths, lifecycle, options = {}) => {
  const expected = expectedProtocolHandler(paths, lifecycle);
  const existing = await readProtocolHandler(paths, options);
  if (existing) {
    if (protocolHandlerMatches(existing, expected)) return expected;
    if (!protocolHandlerMatches(existing, lifecycle.activation)) {
      throw new Error('A different application already uses the Bookarium connector protocol.');
    }
    await removeProtocolHandler(paths, lifecycle.activation, options);
  }
  await runProtocolPowerShell(CREATE_PROTOCOL_SCRIPT, {
    BOOKARIUM_PROTOCOL_COMMAND: expected.command,
    BOOKARIUM_PROTOCOL_DESCRIPTION: expected.description,
    BOOKARIUM_PROTOCOL_REGISTRY_PATH: expected.registryPath,
  }, options);
  const created = await readProtocolHandler(paths, options);
  if (!protocolHandlerMatches(created, expected)) {
    throw new Error('Windows on-demand connector activation verification failed.');
  }
  return expected;
};

export const removeProtocolHandler = async (paths, expected, options = {}) => {
  const actual = await readProtocolHandler(paths, options);
  if (!actual) return false;
  if (!protocolHandlerMatches(actual, expected)) {
    throw new Error('Connector activation ownership could not be verified; it was not removed.');
  }
  await runProtocolPowerShell(REMOVE_PROTOCOL_SCRIPT, {
    BOOKARIUM_PROTOCOL_COMMAND: expected.command,
    BOOKARIUM_PROTOCOL_DESCRIPTION: expected.description,
    BOOKARIUM_PROTOCOL_REGISTRY_PATH: expected.registryPath,
  }, options);
  if (await readProtocolHandler(paths, options)) {
    throw new Error('Windows on-demand connector activation removal failed.');
  }
  return true;
};
