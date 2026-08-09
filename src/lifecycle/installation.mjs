import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_BOOKARIUM_ORIGIN,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
} from '../constants.mjs';
import { requireAllowedOrigin } from '../bridge/origin-policy.mjs';
import { generatePairingToken, isValidPairingToken } from '../bridge/pairing.mjs';
import {
  assertNoLinksInPath,
  atomicWriteJson,
  ensureDirectory,
  pathExists,
  readJsonFile,
  removeOwnedDirectory,
} from './filesystem.mjs';
import { assertPathInside } from './paths.mjs';
import { initializePairingState } from './pairing-state.mjs';

const OWNERSHIP_PRODUCT = 'bookarium-codex-connector';
const STATE_SCHEMA_VERSION = 1;
export const LIFECYCLE_SCHEMA_VERSION = 2;
const CONFIG_SCHEMA_VERSION = 2;
const PACKAGE_FILE_ENTRIES = [
  'bin',
  'src',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'package.json',
];

const installationIdPattern = /^[a-f0-9]{32}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

const hashFile = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const manifestPath = (root) => join(root, 'install-manifest.json');
const portablePath = (root, path) => relative(root, path).split(sep).join('/');

const collectFiles = async (root, path, output) => {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error('Package source contains a filesystem link.');
  if (stats.isFile()) {
    output.push(path);
    return;
  }
  if (!stats.isDirectory()) throw new Error('Package source contains an unsupported entry.');
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) await collectFiles(root, join(path, entry.name), output);
};

const getReviewedPackageFiles = async (sourceRoot) => {
  const rootStats = await lstat(sourceRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Package source root is not a normal directory.');
  }
  const sourcePackage = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (sourcePackage.name !== PACKAGE_NAME || sourcePackage.version !== PACKAGE_VERSION) {
    throw new Error('Package source identity does not match this connector build.');
  }

  const files = [];
  for (const entry of PACKAGE_FILE_ENTRIES) {
    const path = assertPathInside(sourceRoot, join(sourceRoot, entry));
    await collectFiles(sourceRoot, path, files);
  }
  return files;
};

const copyReviewedPackage = async (sourceRoot, destinationRoot) => {
  const files = await getReviewedPackageFiles(sourceRoot);
  const hashes = {};
  for (const source of files) {
    const name = portablePath(sourceRoot, source);
    const destination = assertPathInside(destinationRoot, join(destinationRoot, name));
    await mkdir(dirname(destination), { mode: 0o700, recursive: true });
    await copyFile(source, destination, 1);
    await chmod(destination, name.startsWith('bin/') ? 0o700 : 0o600);
    hashes[name] = await hashFile(destination);
  }
  await atomicWriteJson(destinationRoot, manifestPath(destinationRoot), {
    files: hashes,
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    schemaVersion: STATE_SCHEMA_VERSION,
  });
};

const listInstalledFiles = async (root, current = root, output = []) => {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error('Installed connector contains a filesystem link.');
    if (stats.isDirectory()) await listInstalledFiles(root, path, output);
    else if (stats.isFile() && path !== manifestPath(root)) output.push(portablePath(root, path));
    else if (!stats.isFile()) throw new Error('Installed connector contains an unsupported entry.');
  }
  return output;
};

export const verifyInstalledVersion = async (paths) => {
  await assertNoLinksInPath(paths.dataRoot, paths.versionRoot);
  const manifest = await readJsonFile(paths.manifestFile);
  if (manifest.schemaVersion !== STATE_SCHEMA_VERSION
    || manifest.packageName !== PACKAGE_NAME
    || manifest.packageVersion !== paths.version
    || !manifest.files
    || typeof manifest.files !== 'object'
    || Array.isArray(manifest.files)) {
    throw new Error('Installed connector manifest is invalid.');
  }

  const actualFiles = (await listInstalledFiles(paths.versionRoot)).sort();
  const expectedFiles = Object.keys(manifest.files).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Installed connector file set does not match its manifest.');
  }
  for (const name of expectedFiles) {
    if (!sha256Pattern.test(manifest.files[name])) throw new Error('Installed connector hash is invalid.');
    const path = assertPathInside(paths.versionRoot, join(paths.versionRoot, name));
    if (await hashFile(path) !== manifest.files[name]) throw new Error('Installed connector failed integrity verification.');
  }
  return manifest;
};

export const readOwnership = async (paths) => {
  await assertNoLinksInPath(paths.localAppData, paths.ownershipFile);
  const ownership = await readJsonFile(paths.ownershipFile);
  if (ownership.schemaVersion !== STATE_SCHEMA_VERSION
    || ownership.product !== OWNERSHIP_PRODUCT
    || !installationIdPattern.test(ownership.installationId)) {
    throw new Error('Connector ownership marker is invalid.');
  }
  return ownership;
};

export const ensureOwnedInstallationRoot = async (paths) => {
  await assertNoLinksInPath(paths.localAppData, paths.dataRoot, { includeLeaf: false });
  const existed = await pathExists(paths.dataRoot);
  if (existed) await assertNoLinksInPath(paths.localAppData, paths.dataRoot);
  if (existed && !await pathExists(paths.ownershipFile)) {
    const entries = await readdir(paths.dataRoot);
    if (entries.length > 0) throw new Error('Connector data directory exists without an ownership marker.');
  }
  await ensureDirectory(paths.localAppData, paths.dataRoot);

  if (await pathExists(paths.ownershipFile)) return readOwnership(paths);
  const ownership = {
    createdAt: new Date().toISOString(),
    installationId: randomBytes(16).toString('hex'),
    product: OWNERSHIP_PRODUCT,
    schemaVersion: STATE_SCHEMA_VERSION,
  };
  await atomicWriteJson(paths.dataRoot, paths.ownershipFile, ownership);
  return ownership;
};

export const readConnectorConfig = async (paths) => {
  const ownership = await readOwnership(paths);
  await assertNoLinksInPath(paths.dataRoot, paths.configFile);
  const config = await readJsonFile(paths.configFile);
  const allowedOrigin = requireAllowedOrigin(config.allowedOrigin);
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION
    || config.protocolVersion !== PROTOCOL_VERSION
    || config.installationId !== ownership.installationId
    || !isValidPairingToken(config.controlSecret)
    || Object.hasOwn(config, 'pairingToken')) {
    throw new Error('Connector configuration is invalid.');
  }
  return { ...config, allowedOrigin };
};

const ensureConnectorConfig = async (paths, ownership, allowedOrigin) => {
  if (!await pathExists(paths.configFile)) {
    const config = {
      allowedOrigin,
      controlSecret: generatePairingToken(),
      installationId: ownership.installationId,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: CONFIG_SCHEMA_VERSION,
    };
    await atomicWriteJson(paths.dataRoot, paths.configFile, config);
    await initializePairingState(paths, {
      allowedOrigin,
      installationId: ownership.installationId,
    });
    return readConnectorConfig(paths);
  }

  await assertNoLinksInPath(paths.dataRoot, paths.configFile);
  const existing = await readJsonFile(paths.configFile);
  if (existing.schemaVersion === STATE_SCHEMA_VERSION
    && existing.protocolVersion === PROTOCOL_VERSION
    && existing.installationId === ownership.installationId
    && requireAllowedOrigin(existing.allowedOrigin) === allowedOrigin
    && isValidPairingToken(existing.controlSecret)
    && isValidPairingToken(existing.pairingToken)) {
    await initializePairingState(paths, {
      activeToken: existing.pairingToken,
      allowedOrigin,
      installationId: ownership.installationId,
    });
    await atomicWriteJson(paths.dataRoot, paths.configFile, {
      allowedOrigin,
      controlSecret: existing.controlSecret,
      installationId: ownership.installationId,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: CONFIG_SCHEMA_VERSION,
    });
  }
  const config = await readConnectorConfig(paths);
  if (config.allowedOrigin !== allowedOrigin) {
    throw new Error('The installed connector is locked to a different Bookarium origin.');
  }
  await initializePairingState(paths, {
    allowedOrigin: config.allowedOrigin,
    installationId: config.installationId,
  });
  return config;
};

export const readLifecycle = async (paths) => {
  const ownership = await readOwnership(paths);
  await assertNoLinksInPath(paths.dataRoot, paths.lifecycleFile);
  const lifecycle = await readJsonFile(paths.lifecycleFile);
  const activation = lifecycle.activation ?? null;
  const codexArgsPrefix = lifecycle.codexArgsPrefix ?? [];
  const legacyLifecycle = lifecycle.schemaVersion === STATE_SCHEMA_VERSION;
  if ((!legacyLifecycle && lifecycle.schemaVersion !== LIFECYCLE_SCHEMA_VERSION)
    || lifecycle.installationId !== ownership.installationId
    || lifecycle.version !== paths.version
    || typeof lifecycle.nodePath !== 'string'
    || !isAbsolute(lifecycle.nodePath)
    || typeof lifecycle.startupEnabled !== 'boolean'
    || typeof lifecycle.codexCommand !== 'string'
    || !lifecycle.codexCommand
    || (!legacyLifecycle && !isAbsolute(lifecycle.codexCommand))
    || !Array.isArray(codexArgsPrefix)
    || codexArgsPrefix.length > 1
    || codexArgsPrefix.some((argument) => typeof argument !== 'string' || !isAbsolute(argument))
    || (activation !== null && (
      typeof activation !== 'object'
      || Array.isArray(activation)
      || activation.command === ''
      || typeof activation.command !== 'string'
      || activation.description !== 'URL:Bookarium Codex Connector'
      || activation.registryPath !== paths.activationRegistryPath
      || activation.scheme !== paths.activationScheme
      || activation.uri !== paths.activationUri
    ))) {
    throw new Error('Connector lifecycle metadata is invalid.');
  }
  return { ...lifecycle, activation, codexArgsPrefix };
};

export const installPackage = async (paths, {
  allowedOrigin = DEFAULT_BOOKARIUM_ORIGIN,
  codexArgsPrefix = [],
  codexCommand = process.execPath,
  nodePath = process.execPath,
  startupEnabled = false,
} = {}) => {
  if (!isAbsolute(codexCommand)
    || !Array.isArray(codexArgsPrefix)
    || codexArgsPrefix.length > 1
    || codexArgsPrefix.some((argument) => typeof argument !== 'string' || !isAbsolute(argument))) {
    throw new Error('Codex launch metadata is invalid.');
  }
  const ownership = await ensureOwnedInstallationRoot(paths);
  await ensureDirectory(paths.dataRoot, paths.versionsRoot);

  if (await pathExists(paths.versionRoot)) {
    await verifyInstalledVersion(paths);
  } else {
    const staging = join(paths.versionsRoot, `.staging-${randomBytes(12).toString('hex')}`);
    assertPathInside(paths.versionsRoot, staging);
    await mkdir(staging, { mode: 0o700 });
    try {
      await copyReviewedPackage(paths.packageRoot, staging);
      const stagingPaths = { ...paths, manifestFile: manifestPath(staging), versionRoot: staging };
      await verifyInstalledVersion(stagingPaths);
      await rename(staging, paths.versionRoot);
    } catch (error) {
      await removeOwnedDirectory(paths.versionsRoot, staging).catch(() => {});
      throw error;
    }
  }

  const normalizedOrigin = requireAllowedOrigin(allowedOrigin);
  let previousLifecycle = null;
  if (await pathExists(paths.lifecycleFile)) {
    previousLifecycle = await readLifecycle(paths).catch(() => null);
  }
  await ensureConnectorConfig(paths, ownership, normalizedOrigin);

  await atomicWriteJson(paths.dataRoot, paths.currentFile, {
    schemaVersion: STATE_SCHEMA_VERSION,
    version: paths.version,
  });
  const lifecycle = {
    activation: previousLifecycle?.activation ?? null,
    codexArgsPrefix: codexArgsPrefix.map((argument) => resolve(argument)),
    codexCommand: resolve(codexCommand),
    installationId: ownership.installationId,
    nodePath: resolve(nodePath),
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    startup: previousLifecycle?.startup ?? null,
    startupEnabled,
    version: paths.version,
  };
  await atomicWriteJson(paths.dataRoot, paths.lifecycleFile, lifecycle);
  await ensureDirectory(paths.dataRoot, paths.workspace);
  return { lifecycle, ownership };
};

export const writeLifecycle = async (paths, lifecycle) => {
  await atomicWriteJson(paths.dataRoot, paths.lifecycleFile, lifecycle);
  return readLifecycle(paths);
};

export const validateInstallationForRemoval = async (paths) => {
  const ownership = await readOwnership(paths);
  await assertNoLinksInPath(paths.localAppData, paths.dataRoot);
  return ownership;
};
