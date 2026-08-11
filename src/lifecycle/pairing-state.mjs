import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PAIRING_REQUEST_TTL_MS } from '../constants.mjs';
import { requireAllowedOrigin } from '../bridge/origin-policy.mjs';
import { generatePairingToken, isValidPairingToken } from '../bridge/pairing.mjs';
import { assertNoLinksInPath, atomicWriteJson, pathExists, readJsonFile } from './filesystem.mjs';

const PAIRING_STATE_SCHEMA_VERSION = 1;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/u;

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

const tokenHashMatches = (expectedHash, token) => {
  if (!TOKEN_HASH_PATTERN.test(expectedHash ?? '') || !isValidPairingToken(token)) return false;
  const actualHash = hashToken(token);
  return timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(actualHash, 'hex'));
};

const isTimestamp = (value) => Number.isSafeInteger(value) && value > 0;

const validatePendingRequest = (pending) => {
  if (pending === null) return;
  if (!pending
    || typeof pending !== 'object'
    || Array.isArray(pending)
    || !TOKEN_HASH_PATTERN.test(pending.codeHash ?? '')
    || !isTimestamp(pending.issuedAt)
    || !isTimestamp(pending.expiresAt)
    || pending.expiresAt !== pending.issuedAt + PAIRING_REQUEST_TTL_MS) {
    throw new Error('Connector pairing state is invalid.');
  }
};

const validatePairingState = (state, { allowedOrigin, installationId }) => {
  const normalizedOrigin = requireAllowedOrigin(state.allowedOrigin);
  if (state.schemaVersion !== PAIRING_STATE_SCHEMA_VERSION
    || state.installationId !== installationId
    || normalizedOrigin !== allowedOrigin
    || !Number.isSafeInteger(state.revision)
    || state.revision < 0
    || (state.activeTokenHash !== null && !TOKEN_HASH_PATTERN.test(state.activeTokenHash ?? ''))
    || (state.pairedAt !== null && !isTimestamp(state.pairedAt))
    || (state.revokedAt !== null && !isTimestamp(state.revokedAt))
    || ((state.activeTokenHash === null) !== (state.pairedAt === null))
    || (state.activeTokenHash !== null && state.revokedAt !== null)) {
    throw new Error('Connector pairing state is invalid.');
  }
  validatePendingRequest(state.pending);
  return { ...state, allowedOrigin: normalizedOrigin };
};

export const readPairingState = async (paths, context) => {
  await assertNoLinksInPath(paths.dataRoot, paths.pairingFile);
  return validatePairingState(await readJsonFile(paths.pairingFile), context);
};

export const initializePairingState = async (paths, {
  activeToken = null,
  allowedOrigin,
  installationId,
  now = Date.now(),
} = {}) => {
  const normalizedOrigin = requireAllowedOrigin(allowedOrigin);
  if (!/^[a-f0-9]{32}$/u.test(installationId ?? '')) {
    throw new Error('Invalid connector installation id.');
  }
  if (activeToken !== null && !isValidPairingToken(activeToken)) {
    throw new Error('Invalid legacy pairing token.');
  }
  if (await pathExists(paths.pairingFile)) {
    return readPairingState(paths, { allowedOrigin: normalizedOrigin, installationId });
  }
  const created = {
    activeTokenHash: activeToken === null ? null : hashToken(activeToken),
    allowedOrigin: normalizedOrigin,
    installationId,
    pairedAt: activeToken === null ? null : now,
    pending: null,
    revision: 0,
    revokedAt: null,
    schemaVersion: PAIRING_STATE_SCHEMA_VERSION,
  };
  await atomicWriteJson(paths.dataRoot, paths.pairingFile, created);
  return readPairingState(paths, { allowedOrigin: normalizedOrigin, installationId });
};

export const createPairingAuthority = (paths, {
  allowedOrigin,
  clock = Date.now,
  installationId,
  random = randomBytes,
} = {}) => {
  const context = {
    allowedOrigin: requireAllowedOrigin(allowedOrigin),
    installationId,
  };
  const currentTime = () => {
    const value = clock();
    if (!isTimestamp(value)) throw new Error('Connector pairing clock is invalid.');
    return value;
  };
  let mutation = Promise.resolve();
  const mutate = (operation) => {
    const result = mutation.then(operation, operation);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  };
  const write = async (state) => {
    await atomicWriteJson(paths.dataRoot, paths.pairingFile, state);
    return readPairingState(paths, context);
  };

  return Object.freeze({
    authenticate: async (token) => {
      if (!isValidPairingToken(token)) return false;
      const state = await readPairingState(paths, context);
      return tokenHashMatches(state.activeTokenHash, token);
    },
    exchange: (pairingCode) => mutate(async () => {
      if (!isValidPairingToken(pairingCode)) return null;
      const state = await readPairingState(paths, context);
      const now = currentTime();
      if (!state.pending
        || now >= state.pending.expiresAt
        || !tokenHashMatches(state.pending.codeHash, pairingCode)) return null;

      const token = generatePairingToken(random);
      await write({
        ...state,
        activeTokenHash: hashToken(token),
        pairedAt: now,
        pending: null,
        revision: state.revision + 1,
        revokedAt: null,
      });
      return token;
    }),
    issue: () => mutate(async () => {
      const state = await readPairingState(paths, context);
      const pairingCode = generatePairingToken(random);
      const issuedAt = currentTime();
      await write({
        ...state,
        pending: {
          codeHash: hashToken(pairingCode),
          expiresAt: issuedAt + PAIRING_REQUEST_TTL_MS,
          issuedAt,
        },
        revision: state.revision + 1,
      });
      return { expiresAt: issuedAt + PAIRING_REQUEST_TTL_MS, pairingCode };
    }),
    revoke: () => mutate(async () => {
      const state = await readPairingState(paths, context);
      const revokedAt = currentTime();
      await write({
        ...state,
        activeTokenHash: null,
        pairedAt: null,
        pending: null,
        revision: state.revision + 1,
        revokedAt,
      });
      return { revokedAt };
    }),
    status: async () => {
      const state = await readPairingState(paths, context);
      return {
        paired: state.activeTokenHash !== null,
        pending: Boolean(state.pending && currentTime() < state.pending.expiresAt),
      };
    },
  });
};
