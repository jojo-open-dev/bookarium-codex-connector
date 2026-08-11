import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION } from '../constants.mjs';

const DEFAULT_PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WINDOWS_STARTUP_SEGMENTS = [
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
];

export class UnsupportedPlatformError extends Error {
  constructor(platform) {
    super(`Bookarium Codex Connector lifecycle is not implemented for ${platform}.`);
    this.name = 'UnsupportedPlatformError';
  }
}

const requireAbsoluteDirectory = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute directory.`);
  }
  const normalized = resolve(value);
  if (normalized === resolve(normalized, sep)) throw new Error(`${label} must not be a filesystem root.`);
  return normalized;
};

export const assertPathInside = (boundary, candidate, { allowEqual = false } = {}) => {
  const normalizedBoundary = resolve(boundary);
  const normalizedCandidate = resolve(candidate);
  const relation = relative(normalizedBoundary, normalizedCandidate);
  if ((!allowEqual && relation === '') || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Path escaped its owned boundary.');
  }
  return normalizedCandidate;
};

export const createLifecyclePaths = ({
  environment = process.env,
  packageRoot = DEFAULT_PACKAGE_ROOT,
  platform = process.platform,
  version = PACKAGE_VERSION,
} = {}) => {
  if (platform !== 'win32') throw new UnsupportedPlatformError(platform);
  const localAppData = requireAbsoluteDirectory(environment.LOCALAPPDATA, 'LOCALAPPDATA');
  const roamingAppData = requireAbsoluteDirectory(environment.APPDATA, 'APPDATA');
  const dataRoot = join(localAppData, 'Bookarium', 'Codex Connector');
  const versionsRoot = join(dataRoot, 'versions');
  const versionRoot = join(versionsRoot, version);
  const startupFolder = join(roamingAppData, ...WINDOWS_STARTUP_SEGMENTS);

  assertPathInside(localAppData, dataRoot);
  assertPathInside(dataRoot, versionsRoot);
  assertPathInside(versionsRoot, versionRoot);
  assertPathInside(roamingAppData, startupFolder);

  return Object.freeze({
    configFile: join(dataRoot, 'config.json'),
    currentFile: join(dataRoot, 'current.json'),
    dataRoot,
    installedBinary: join(versionRoot, 'bin', 'bookarium-codex-connector.mjs'),
    lifecycleFile: join(dataRoot, 'lifecycle.json'),
    localAppData,
    lockFile: join(dataRoot, 'run.lock'),
    manifestFile: join(versionRoot, 'install-manifest.json'),
    nodePath: resolve(process.execPath),
    ownershipFile: join(dataRoot, 'ownership.json'),
    packageRoot: resolve(packageRoot),
    processFile: join(dataRoot, 'process.json'),
    roamingAppData,
    startupFile: join(startupFolder, 'Bookarium Codex Connector.lnk'),
    startupFolder,
    version,
    versionRoot,
    versionsRoot,
    workspace: join(dataRoot, 'workspace'),
  });
};
