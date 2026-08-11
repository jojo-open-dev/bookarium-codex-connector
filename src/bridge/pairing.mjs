import { randomBytes, timingSafeEqual } from 'node:crypto';

export const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const generatePairingToken = (random = randomBytes) => random(32).toString('base64url');

export const isValidPairingToken = (value) => (
  typeof value === 'string' && PAIRING_TOKEN_PATTERN.test(value)
);

export const pairingTokenMatches = (expected, supplied) => {
  if (!isValidPairingToken(expected) || !isValidPairingToken(supplied)) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return timingSafeEqual(expectedBytes, suppliedBytes);
};
