import { spawn } from 'node:child_process';
import { win32 as windowsPath } from 'node:path';
import { requireAllowedOrigin } from '../bridge/origin-policy.mjs';
import { isValidPairingToken } from '../bridge/pairing.mjs';

export const PAIRING_FRAGMENT_KEY = 'bookarium-codex-pairing';

export const createPairingUrl = (allowedOrigin, pairingCode) => {
  if (!isValidPairingToken(pairingCode)) throw new Error('Invalid browser pairing code.');
  const url = new URL(requireAllowedOrigin(allowedOrigin));
  url.pathname = '/';
  url.search = '';
  url.hash = new URLSearchParams({ [PAIRING_FRAGMENT_KEY]: pairingCode }).toString();
  return url.href;
};

export const openBrowser = (url, {
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
} = {}) => {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Invalid browser pairing URL.');
  if (platform !== 'win32') throw new Error(`Opening browser pairing is not implemented for ${platform}.`);
  const windowsRoot = environment.SystemRoot ?? environment.WINDIR;
  if (typeof windowsRoot !== 'string' || !windowsPath.isAbsolute(windowsRoot)) {
    throw new Error('Windows system directory is unavailable.');
  }
  const urlHandler = windowsPath.join(windowsPath.resolve(windowsRoot), 'System32', 'rundll32.exe');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(urlHandler, ['url.dll,FileProtocolHandler', target.href], {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      reject(new Error('The Bookarium pairing page could not be opened.'));
      return;
    }
    child.once('error', () => reject(new Error('The Bookarium pairing page could not be opened.')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
};
