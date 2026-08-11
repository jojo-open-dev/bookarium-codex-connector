import { DEFAULT_BOOKARIUM_ORIGIN, PACKAGE_VERSION, PROTOCOL_VERSION } from '../constants.mjs';
import { requireAllowedOrigin } from '../bridge/origin-policy.mjs';
import { pathExists, removeOwnedDirectory } from '../lifecycle/filesystem.mjs';
import {
  installPackage,
  readConnectorConfig,
  readLifecycle,
  validateInstallationForRemoval,
  verifyInstalledVersion,
  writeLifecycle,
} from '../lifecycle/installation.mjs';
import { createLifecyclePaths } from '../lifecycle/paths.mjs';
import { checkPrerequisites } from '../lifecycle/prerequisites.mjs';
import {
  getManagedStatus,
  startManagedProcess,
  stopManagedProcess,
} from '../lifecycle/process.mjs';
import {
  createStartupShortcut,
  readStartupShortcut,
  removeStartupShortcut,
  startupShortcutMatches,
} from '../lifecycle/startup/windows.mjs';

const line = (output, value) => output.write(`${value}\n`);

const parseInstallArguments = (args) => {
  let allowedOrigin = DEFAULT_BOOKARIUM_ORIGIN;
  let startupEnabled = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allowed-origin') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--allowed-origin requires a value.');
      allowedOrigin = requireAllowedOrigin(value);
      index += 1;
    } else if (argument === '--no-startup') {
      startupEnabled = false;
    } else {
      throw new Error(`Unknown install option: ${argument}`);
    }
  }
  return { allowedOrigin, startupEnabled };
};

const configureStartup = async (paths, lifecycle, dependencies) => {
  if (!lifecycle.startupEnabled) {
    if (lifecycle.startup) await removeStartupShortcut(paths, lifecycle.startup, dependencies);
    return writeLifecycle(paths, { ...lifecycle, startup: null });
  }
  const startup = await createStartupShortcut(paths, lifecycle, dependencies);
  return writeLifecycle(paths, { ...lifecycle, startup });
};

export const installCommand = async (args, {
  environment = process.env,
  output = process.stdout,
  packageRoot,
  paths = createLifecyclePaths({ environment, packageRoot }),
  prerequisiteCheck = checkPrerequisites,
  start = startManagedProcess,
  startupOptions = { environment },
} = {}) => {
  const options = parseInstallArguments(args);
  const prerequisites = await prerequisiteCheck({ environment });
  const { lifecycle: initialLifecycle } = await installPackage(paths, {
    allowedOrigin: options.allowedOrigin,
    startupEnabled: options.startupEnabled,
  });
  const running = await start(paths, { environment });
  const lifecycle = await configureStartup(paths, initialLifecycle, startupOptions);
  line(output, `Bookarium Codex Connector ${PACKAGE_VERSION} installed for the current user.`);
  line(output, `Location: ${paths.dataRoot}`);
  line(output, `Startup: ${lifecycle.startup ? 'enabled' : 'disabled'}`);
  line(output, `Codex: ${prerequisites.codexVersion}`);
  line(output, running.alreadyRunning ? 'Connector was already running.' : 'Connector started.');
  line(output, 'Browser pairing is not yet enabled in Milestone 2.');
  return 0;
};

export const startCommand = async ({
  environment = process.env,
  output = process.stdout,
  paths = createLifecyclePaths({ environment }),
  start = startManagedProcess,
} = {}) => {
  const result = await start(paths, { environment });
  line(output, result.alreadyRunning ? 'Bookarium Codex Connector is already running.' : 'Bookarium Codex Connector started.');
  return 0;
};

export const stopCommand = async ({
  environment = process.env,
  output = process.stdout,
  paths = createLifecyclePaths({ environment }),
  stop = stopManagedProcess,
} = {}) => {
  const stopped = await stop(paths);
  line(output, stopped ? 'Bookarium Codex Connector stopped.' : 'Bookarium Codex Connector is not running.');
  return 0;
};

export const statusCommand = async ({
  environment = process.env,
  output = process.stdout,
  paths = createLifecyclePaths({ environment }),
  prerequisiteCheck = checkPrerequisites,
  startupOptions = { environment },
  status = getManagedStatus,
} = {}) => {
  await verifyInstalledVersion(paths);
  const lifecycle = await readLifecycle(paths);
  const config = await readConnectorConfig(paths);
  const runtime = await status(paths);
  const actualStartup = await readStartupShortcut(paths, startupOptions);
  const startupRegistered = Boolean(lifecycle.startup
    && actualStartup
    && startupShortcutMatches(actualStartup, lifecycle.startup));
  const codexAvailable = await prerequisiteCheck({ environment }).then(() => true, () => false);
  line(output, `Package version: ${PACKAGE_VERSION}`);
  line(output, `Protocol version: ${PROTOCOL_VERSION}`);
  line(output, `Process: ${runtime.running ? 'running' : 'stopped'}`);
  line(output, `Address: ${runtime.address}`);
  line(output, `Allowed origin: ${config.allowedOrigin}`);
  line(output, `Codex: ${codexAvailable ? 'available' : 'unavailable'}`);
  line(output, `Authentication: ${runtime.account?.type ?? 'unavailable'}`);
  line(output, `Plan: ${runtime.account?.planType ?? 'unavailable'}`);
  line(output, `Startup: ${startupRegistered ? 'registered' : lifecycle.startupEnabled ? 'needs repair' : 'disabled'}`);
  return runtime.running ? 0 : 3;
};

export const repairCommand = async ({
  environment = process.env,
  output = process.stdout,
  paths = createLifecyclePaths({ environment }),
  prerequisiteCheck = checkPrerequisites,
  start = startManagedProcess,
  startupOptions = { environment },
} = {}) => {
  await prerequisiteCheck({ environment });
  await verifyInstalledVersion(paths);
  await readConnectorConfig(paths);
  const lifecycle = await readLifecycle(paths);
  await configureStartup(paths, lifecycle, startupOptions);
  await start(paths, { environment });
  line(output, 'Bookarium Codex Connector lifecycle repaired without changing pairing data.');
  return 0;
};

export const uninstallCommand = async ({
  environment = process.env,
  output = process.stdout,
  paths = createLifecyclePaths({ environment }),
  startupOptions = { environment },
  stop = stopManagedProcess,
} = {}) => {
  if (!await pathExists(paths.dataRoot)) {
    line(output, 'Bookarium Codex Connector is not installed.');
    return 0;
  }
  await validateInstallationForRemoval(paths);
  const lifecycle = await readLifecycle(paths);
  await stop(paths);
  await removeStartupShortcut(paths, lifecycle.startup, startupOptions);
  await validateInstallationForRemoval(paths);
  await removeOwnedDirectory(paths.localAppData, paths.dataRoot, {
    ownershipMarker: paths.ownershipFile,
  });
  line(output, 'Bookarium Codex Connector was removed. Node.js, Codex, and Codex authentication were left untouched.');
  return 0;
};
