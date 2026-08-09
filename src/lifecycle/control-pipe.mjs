import { connect } from 'node:net';

const MAX_CONTROL_BYTES = 4 * 1_024;

export const getControlPipeName = (installationId) => {
  if (!/^[a-f0-9]{32}$/u.test(installationId)) throw new Error('Invalid connector installation id.');
  return `\\\\.\\pipe\\bookarium-codex-connector-${installationId}`;
};

export const sendControlRequest = ({
  action,
  controlSecret,
  installationId,
  pipeName = getControlPipeName(installationId),
  timeoutMs = 2_000,
} = {}) => new Promise((resolve, reject) => {
  let settled = false;
  let bytes = 0;
  let timer = null;
  const chunks = [];
  const socket = connect(pipeName);
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    callback(value);
  };
  socket.once('connect', () => {
    socket.write(`${JSON.stringify({ action, controlSecret, installationId })}\n`);
  });
  socket.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_CONTROL_BYTES) {
      finish(reject, new Error('Connector control response exceeded its limit.'));
      return;
    }
    chunks.push(chunk);
  });
  socket.once('end', () => {
    try {
      const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response || typeof response !== 'object') throw new Error();
      finish(resolve, response);
    } catch {
      finish(reject, new Error('Connector control response was invalid.'));
    }
  });
  socket.once('error', (error) => {
    if (['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error?.code)) finish(resolve, null);
    else finish(reject, new Error('Connector control channel failed.'));
  });
  timer = setTimeout(() => finish(resolve, null), timeoutMs);
  timer.unref?.();
});
