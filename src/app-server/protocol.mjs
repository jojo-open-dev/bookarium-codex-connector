import { MAX_APP_SERVER_FRAME_BYTES } from '../constants.mjs';

export class AppServerProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppServerProtocolError';
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const encodeAppServerMessage = (message) => {
  if (!isObject(message)) throw new AppServerProtocolError('App Server message must be an object.');
  const encoded = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(encoded) > MAX_APP_SERVER_FRAME_BYTES) {
    throw new AppServerProtocolError('Outgoing App Server message is too large.');
  }
  return encoded;
};

export const parseAppServerFrame = (frame, maximumBytes = MAX_APP_SERVER_FRAME_BYTES) => {
  const bytes = Buffer.isBuffer(frame) ? frame.length : Buffer.byteLength(frame);
  if (bytes === 0 || bytes > maximumBytes) {
    throw new AppServerProtocolError('Invalid App Server frame size.');
  }

  let message;
  try {
    message = JSON.parse(Buffer.isBuffer(frame) ? frame.toString('utf8') : frame);
  } catch {
    throw new AppServerProtocolError('App Server emitted malformed JSON.');
  }
  if (!isObject(message)) throw new AppServerProtocolError('App Server frame must contain an object.');

  const hasId = Object.hasOwn(message, 'id');
  const hasMethod = typeof message.method === 'string' && message.method.length > 0;
  if (!hasId && !hasMethod) throw new AppServerProtocolError('App Server message has no id or method.');
  if (hasId && !['string', 'number'].includes(typeof message.id)) {
    throw new AppServerProtocolError('App Server message id is invalid.');
  }
  if (Object.hasOwn(message, 'params') && !isObject(message.params)) {
    throw new AppServerProtocolError('App Server message params are invalid.');
  }
  return message;
};

export const toSafeAccount = (result) => {
  const account = isObject(result) && isObject(result.account) ? result.account : null;
  if (!account || typeof account.type !== 'string' || account.type.length > 64) return null;
  const planType = typeof account.planType === 'string' && account.planType.length <= 64
    ? account.planType
    : null;
  return { type: account.type, planType };
};
