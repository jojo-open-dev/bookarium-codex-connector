import { createServer } from 'node:http';
import {
  DEFAULT_BRIDGE_HOST,
  HTTP_REQUEST_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_PROMPT_LENGTH,
  MAX_RESPONSE_BYTES,
  PROTOCOL_VERSION,
} from '../constants.mjs';
import { ConnectorBusyError, UnsafeToolActivityError } from '../app-server/client.mjs';
import { toSafeAccount } from '../app-server/protocol.mjs';
import { requireAllowedOrigin, requestOriginMatches } from './origin-policy.mjs';
import { isValidPairingToken, pairingTokenMatches } from './pairing.mjs';

const PUBLIC_PATHS = new Set(['/v1/account', '/v1/ask']);

export class BridgeHttpError extends Error {
  constructor(statusCode, publicMessage, { allow = null } = {}) {
    super(publicMessage);
    this.name = 'BridgeHttpError';
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    this.allow = allow;
  }
}

const hasRequestBody = (request) => {
  const length = request.headers['content-length'];
  return request.headers['transfer-encoding'] !== undefined
    || (typeof length === 'string' && length !== '0');
};

const readJsonBody = async (request) => {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new BridgeHttpError(413, 'Request body is too large.');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeHttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeHttpError(400, 'Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeHttpError(400, 'Request body must be a JSON object.');
  }
  return value;
};

const corsHeaders = (allowedOrigin) => ({
  'Access-Control-Allow-Origin': allowedOrigin,
  Vary: 'Origin',
});

const writeJson = (response, statusCode, value, allowedOrigin = null, extraHeaders = {}) => {
  let body = JSON.stringify(value);
  let finalStatus = statusCode;
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    finalStatus = 502;
    body = JSON.stringify({ error: 'Codex answer exceeded the connector response limit.' });
  }

  response.writeHead(finalStatus, {
    ...(allowedOrigin ? corsHeaders(allowedOrigin) : {}),
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
};

const parseBearerToken = (header) => {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header);
  return match?.[1] ?? null;
};

const validatePreflight = (request, path) => {
  const requestedMethod = request.headers['access-control-request-method'];
  const expectedMethod = path === '/v1/account' ? 'GET' : 'POST';
  if (requestedMethod !== expectedMethod) {
    throw new BridgeHttpError(403, 'CORS preflight is not allowed.');
  }

  const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = new Set(['authorization', 'content-type']);
  if (!requestedHeaders.includes('authorization')
    || requestedHeaders.some((header) => !allowedHeaders.has(header))
    || (path === '/v1/ask' && !requestedHeaders.includes('content-type'))) {
    throw new BridgeHttpError(403, 'CORS preflight is not allowed.');
  }

  return {
    'Access-Control-Allow-Headers': path === '/v1/ask'
      ? 'Authorization, Content-Type'
      : 'Authorization',
    'Access-Control-Allow-Methods': expectedMethod,
    ...(request.headers['access-control-request-private-network'] === 'true'
      ? { 'Access-Control-Allow-Private-Network': 'true' }
      : {}),
    'Access-Control-Allow-Origin': request.headers.origin,
    'Cache-Control': 'no-store',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
};

export const createBridgeServer = ({ allowedOrigin, client, token }) => {
  const normalizedOrigin = requireAllowedOrigin(allowedOrigin);
  if (!isValidPairingToken(token)) throw new Error('A 256-bit base64url pairing token is required.');
  if (!client || typeof client.readAccount !== 'function' || typeof client.ask !== 'function') {
    throw new Error('A Codex App Server client is required.');
  }

  const server = createServer(async (request, response) => {
    let responseOrigin = null;
    try {
      if (typeof request.url !== 'string' || !request.url.startsWith('/')) {
        throw new BridgeHttpError(400, 'Invalid request target.');
      }
      const url = new URL(request.url, `http://${DEFAULT_BRIDGE_HOST}`);
      const path = url.search ? '' : url.pathname;

      if (path === '/readyz') {
        if (request.method !== 'GET') {
          throw new BridgeHttpError(405, 'Method not allowed.', { allow: 'GET' });
        }
        if (hasRequestBody(request)) throw new BridgeHttpError(400, 'Request body is not allowed.');
        writeJson(response, 200, { ready: true, version: PROTOCOL_VERSION });
        return;
      }

      if (!PUBLIC_PATHS.has(path)) throw new BridgeHttpError(404, 'Connector route not found.');
      if (!requestOriginMatches(request.headers.origin, normalizedOrigin)) {
        throw new BridgeHttpError(403, 'Browser origin is not allowed.');
      }
      responseOrigin = normalizedOrigin;

      if (request.method === 'OPTIONS') {
        response.writeHead(204, validatePreflight(request, path));
        response.end();
        return;
      }

      const expectedMethod = path === '/v1/account' ? 'GET' : 'POST';
      if (request.method !== expectedMethod) {
        throw new BridgeHttpError(405, 'Method not allowed.', { allow: expectedMethod });
      }

      const suppliedToken = parseBearerToken(request.headers.authorization);
      if (!pairingTokenMatches(token, suppliedToken)) {
        throw new BridgeHttpError(401, 'Connector authorization is invalid.');
      }

      if (path === '/v1/account') {
        if (hasRequestBody(request)) throw new BridgeHttpError(400, 'Request body is not allowed.');
        const account = await client.readAccount();
        writeJson(response, 200, {
          account: toSafeAccount({ account }),
          version: PROTOCOL_VERSION,
        }, normalizedOrigin);
        return;
      }

      const mediaType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== 'application/json') {
        throw new BridgeHttpError(415, 'Content-Type must be application/json.');
      }
      const body = await readJsonBody(request);
      if (Object.keys(body).some((key) => key !== 'prompt')) {
        throw new BridgeHttpError(400, 'Request body contains unsupported fields.');
      }
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) throw new BridgeHttpError(400, 'Enter a study question.');
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new BridgeHttpError(400, `Keep the question under ${MAX_PROMPT_LENGTH} characters.`);
      }
      const account = toSafeAccount({ account: await client.readAccount() });
      if (account?.type !== 'chatgpt') {
        throw new BridgeHttpError(409, 'Codex must be signed in with ChatGPT.');
      }

      const answer = await client.ask(prompt);
      writeJson(response, 200, { answer }, normalizedOrigin);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      let statusCode = 500;
      let publicMessage = 'The local Codex connector failed.';
      let allow = null;
      if (error instanceof BridgeHttpError) {
        statusCode = error.statusCode;
        publicMessage = error.publicMessage;
        allow = error.allow;
      } else if (error instanceof ConnectorBusyError) {
        statusCode = 409;
        publicMessage = error.message;
      } else if (error instanceof UnsafeToolActivityError) {
        statusCode = 502;
        publicMessage = error.message;
      }
      writeJson(
        response,
        statusCode,
        { error: publicMessage },
        responseOrigin,
        allow ? { Allow: allow } : {},
      );
    }
  });

  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  return server;
};
