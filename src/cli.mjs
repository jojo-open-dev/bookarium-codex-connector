import { PACKAGE_NAME, PACKAGE_VERSION, PROTOCOL_VERSION } from './constants.mjs';
import {
  installCommand,
  pairCommand,
  repairCommand,
  revokeCommand,
  startCommand,
  statusCommand,
  stopCommand,
  uninstallCommand,
} from './commands/lifecycle.mjs';
import { runManagedService } from './runtime/managed-service.mjs';
import { startConnectorServer } from './index.mjs';

export const HELP_TEXT = `Bookarium Codex Connector ${PACKAGE_VERSION} Beta

Usage:
  bookarium-codex-connector install [--allowed-origin <origin>] [--no-startup]
  bookarium-codex-connector start
  bookarium-codex-connector status
  bookarium-codex-connector pair
  bookarium-codex-connector revoke
  bookarium-codex-connector stop
  bookarium-codex-connector repair
  bookarium-codex-connector uninstall
  bookarium-codex-connector --version
  bookarium-codex-connector --help

Commands:
  install     Install for the current user, register startup, and start the connector.
  start       Start the installed connector if it is not already running.
  status      Show safe connector, Codex, account, origin, and startup status.
  pair        Open a short-lived, single-use browser pairing request.
  revoke      Revoke browser access without changing Codex authentication.
  stop        Stop only the authenticated process owned by this installation.
  repair      Verify files and recreate lifecycle configuration without rotating pairing.
  uninstall   Remove only Bookarium-owned connector files and startup registration.
  serve       Development-only checked-out-repository runner using environment configuration.
`;

const write = (stream, value) => {
  stream.write(value.endsWith('\n') ? value : `${value}\n`);
};

const quietOutput = { write() {} };

export const runCli = async (
  args = process.argv.slice(2),
  {
    commandHandlers = {
      install: installCommand,
      pair: pairCommand,
      repair: repairCommand,
      revoke: revokeCommand,
      start: startCommand,
      status: statusCommand,
      stop: stopCommand,
      uninstall: uninstallCommand,
    },
    environment = process.env,
    managedService = runManagedService,
    startServer = startConnectorServer,
    stderr = process.stderr,
    stdout = process.stdout,
  } = {},
) => {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    write(stdout, HELP_TEXT);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    write(stdout, `${PACKAGE_NAME} ${PACKAGE_VERSION} (protocol ${PROTOCOL_VERSION})`);
    return 0;
  }

  const command = args[0];
  if (command === 'run-managed') {
    if (args.length !== 1) throw new Error('run-managed does not accept arguments.');
    await managedService();
    return 0;
  }
  if (command === 'start-managed') {
    if (args.length !== 1) throw new Error('start-managed does not accept arguments.');
    return commandHandlers.start({ environment, output: quietOutput });
  }
  if (Object.hasOwn(commandHandlers, command)) {
    if (command === 'install') {
      return commandHandlers.install(args.slice(1), { environment, output: stdout });
    }
    if (args.length !== 1) throw new Error(`${command} does not accept arguments.`);
    return commandHandlers[command]({ environment, output: stdout });
  }
  if (command !== 'serve' || args.length !== 1) {
    write(stderr, 'Unknown command. Run bookarium-codex-connector --help.');
    return 2;
  }

  const running = await startServer({
    allowedOrigin: environment.BOOKARIUM_CODEX_ALLOWED_ORIGIN,
    token: environment.BOOKARIUM_CODEX_PAIRING_TOKEN,
  });
  const port = running.address?.port;
  write(stdout, `Bookarium Codex Connector is ready on 127.0.0.1:${port}.`);

  await new Promise((resolve) => {
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
      await running.close();
      resolve();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
  return 0;
};
