import { CodexAppServerClient } from './app-server/client.mjs';
import { createBridgeServer } from './bridge/http-server.mjs';
import { requireAllowedOrigin } from './bridge/origin-policy.mjs';
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from './constants.mjs';

export { CodexAppServerClient } from './app-server/client.mjs';
export { createBridgeServer } from './bridge/http-server.mjs';
export { generatePairingToken } from './bridge/pairing.mjs';
export * from './constants.mjs';

export const startConnectorServer = async ({
  allowedOrigin,
  client = new CodexAppServerClient(),
  pairing,
  port = DEFAULT_BRIDGE_PORT,
  token,
} = {}) => {
  const normalizedOrigin = requireAllowedOrigin(allowedOrigin);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid connector port.');

  await client.start?.();
  const server = createBridgeServer({
    allowedOrigin: normalizedOrigin,
    client,
    pairing,
    token,
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, DEFAULT_BRIDGE_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await client.stop?.();
    throw error;
  }

  return {
    address: server.address(),
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await client.stop?.();
    },
    server,
  };
};
