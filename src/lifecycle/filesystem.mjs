import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertPathInside } from './paths.mjs';

export const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const comparablePath = (path) => (
  process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
);

export const assertNoLinksInPath = async (boundary, candidate, { includeLeaf = true } = {}) => {
  const checkedCandidate = assertPathInside(boundary, candidate, { allowEqual: true });
  const relation = relative(resolve(boundary), checkedCandidate);
  const segments = relation ? relation.split(sep) : [];
  if (!includeLeaf) segments.pop();

  let current = resolve(boundary);
  const paths = [current];
  for (const segment of segments) {
    current = join(current, segment);
    paths.push(current);
  }

  for (const path of paths) {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error('Connector path contains a symbolic link or junction.');
    const canonical = await realpath(path);
    if (comparablePath(canonical) !== comparablePath(path)) {
      throw new Error('Connector path resolves through a filesystem link.');
    }
  }
  return checkedCandidate;
};

export const ensureDirectory = async (boundary, directory, mode = 0o700) => {
  assertPathInside(boundary, directory, { allowEqual: true });
  await assertNoLinksInPath(boundary, directory, { includeLeaf: false });
  await mkdir(directory, { mode, recursive: true });
  await assertNoLinksInPath(boundary, directory);
  await chmod(directory, mode);
};

export const readJsonFile = async (path) => {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 256 * 1_024) {
    throw new Error('Invalid JSON state file.');
  }
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON state file.');
  return value;
};

export const atomicWriteJson = async (boundary, path, value, mode = 0o600) => {
  assertPathInside(boundary, path);
  const parent = dirname(path);
  await ensureDirectory(boundary, parent);
  await assertNoLinksInPath(boundary, path, { includeLeaf: false });
  const temporary = join(parent, `.${randomBytes(12).toString('hex')}.tmp`);
  assertPathInside(boundary, temporary);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, mode);
  try {
    if (await pathExists(path)) await assertNoLinksInPath(boundary, path);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await assertNoLinksInPath(boundary, path);
};

export const assertTreeContainsNoLinks = async (root) => {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Owned connector root is not a normal directory.');
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error('Owned connector tree contains a filesystem link.');
    if (stats.isDirectory()) await assertTreeContainsNoLinks(path);
    else if (!stats.isFile()) throw new Error('Owned connector tree contains an unsupported filesystem entry.');
  }
};

export const removeOwnedDirectory = async (boundary, target, { ownershipMarker = null } = {}) => {
  assertPathInside(boundary, target);
  if (!await pathExists(target)) return;
  await assertNoLinksInPath(boundary, target);
  await assertTreeContainsNoLinks(target);

  if (ownershipMarker) {
    const checkedMarker = assertPathInside(target, ownershipMarker);
    if (dirname(checkedMarker) !== resolve(target)) {
      throw new Error('Ownership marker must be a direct child of the owned directory.');
    }
    await assertNoLinksInPath(target, checkedMarker);
    const entries = await readdir(target);
    for (const entry of entries) {
      const path = join(target, entry);
      if (comparablePath(path) === comparablePath(checkedMarker)) continue;
      await rm(path, { force: false, recursive: true });
    }
    await unlink(checkedMarker);
    await rmdir(target);
    return;
  }
  await rm(target, { force: false, recursive: true });
};
