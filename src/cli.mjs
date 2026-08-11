import { PACKAGE_NAME, PACKAGE_VERSION, PROTOCOL_VERSION } from './constants.mjs';
import { startConnectorServer } from './index.mjs';

const RESERVED_LIFECYCLE_COMMANDS = new Set([
  'install',
  'repair',
  'start',
  'status',
  'stop',
  'uninstall',
]);

export const HELP_TEXT = `Bookarium Codex Connector ${PACKAGE_VERSION} Beta

Usage:
  bookarium-codex-connector --help
  bookarium-codex-connector --version
  bookarium-codex-connector serve

Commands:
  serve       Run Milestone 1 from this checkout using protected environment configuration.
  install     Reserved for the reviewed per-user installer (Milestone 2/3).
  start       Reserved for managed background startup (Milestone 2).
  status      Reserved for safe status inspection (Milestone 2).
  stop        Reserved for verified process shutdown (Milestone 2).
  repair      Reserved for safe lifecycle repair (Milestone 2).
  uninstall   Reserved for narrow removal (Milestone 2).

The serve command reads BOOKARIUM_CODEX_ALLOWED_ORIGIN and
BOOKARIUM_CODEX_PAIRING_TOKEN. It never prints the token.
`;

const write = (stream, value) => {
  stream.write(value.endsWith('\n') ? value : `${value}\n`);
};

export const runCli = async (
  args = process.argv.slice(2),
  {
    environment = process.env,
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
  if (RESERVED_LIFECYCLE_COMMANDS.has(command)) {
    write(stderr, `${command} is reserved and intentionally unavailable in Milestone 1; no system changes were made.`);
    return 2;
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
