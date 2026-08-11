import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const PACKAGE_NAME = '@bookarium/codex-connector';
const PACKAGE_VERSION = '0.1.0';
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_COMPRESSED_TARBALL_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_TARBALL_BYTES = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['', '.js', '.json', '.md', '.mjs', '.yml', '.yaml']);

export const EXPECTED_PACKED_FILES = Object.freeze([
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'bin/bookarium-codex-connector.mjs',
  'docs/windows-startup.md',
  'package.json',
  'src/app-server/client.mjs',
  'src/app-server/protocol.mjs',
  'src/bridge/http-server.mjs',
  'src/bridge/origin-policy.mjs',
  'src/bridge/pairing.mjs',
  'src/cli.mjs',
  'src/commands/lifecycle.mjs',
  'src/constants.mjs',
  'src/index.mjs',
  'src/lifecycle/browser.mjs',
  'src/lifecycle/control-pipe.mjs',
  'src/lifecycle/filesystem.mjs',
  'src/lifecycle/installation.mjs',
  'src/lifecycle/pairing-state.mjs',
  'src/lifecycle/paths.mjs',
  'src/lifecycle/prerequisites.mjs',
  'src/lifecycle/process.mjs',
  'src/lifecycle/startup/windows.mjs',
  'src/lifecycle/subprocess.mjs',
  'src/runtime/managed-service.mjs',
]);

const EXPECTED_PACKED_DIRECTORIES = new Set(['package']);
for (const path of EXPECTED_PACKED_FILES) {
  const segments = path.split('/');
  let current = 'package';
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    EXPECTED_PACKED_DIRECTORIES.add(current);
  }
}

const SECRET_PATTERNS = Object.freeze([
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u],
  ['GitHub token', /\b(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/u],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/u],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ['bearer credential', /\bBearer [A-Za-z0-9_-]{40,}\b/u],
]);

const sameLists = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export const validatePackReport = (report) => {
  if (!Array.isArray(report) || report.length !== 1) throw new Error('npm pack returned an unexpected report.');
  const entry = report[0];
  if (!entry
    || entry.name !== PACKAGE_NAME
    || entry.version !== PACKAGE_VERSION
    || !Array.isArray(entry.files)
    || !Array.isArray(entry.bundled)
    || entry.bundled.length !== 0) {
    throw new Error('Packed package identity or dependency metadata is invalid.');
  }
  const actual = entry.files.map((file) => file?.path).sort();
  const expected = [...EXPECTED_PACKED_FILES].sort();
  if (!sameLists(actual, expected) || entry.entryCount !== expected.length) {
    throw new Error('Packed file list differs from the reviewed release allowlist.');
  }
  if (entry.files.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0)) {
    throw new Error('Packed file metadata contains an invalid size.');
  }
  return entry;
};

export const findPotentialSecrets = (entries) => {
  const findings = [];
  for (const entry of entries) {
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(entry.content)) findings.push({ label, path: entry.path });
    }
  }
  return findings;
};

export const validateText = (path, content) => {
  if (content.includes('\0')) throw new Error(`${path} contains a NUL byte.`);
  if (content.includes('\r')) throw new Error(`${path} must use LF line endings.`);
  const lines = content.split('\n');
  if (lines.some((line) => /[\t ]+$/u.test(line))) throw new Error(`${path} contains trailing whitespace.`);
};

export const validateWorkflowPolicy = (path, content) => {
  if (/\bpull_request_target\s*:/u.test(content)) {
    throw new Error(`${path} must not use pull_request_target.`);
  }
  if (/\bnpm\s+publish\b/iu.test(content)
    || /\bid-token\s*:\s*write\b/iu.test(content)
    || /\bcontents\s*:\s*write\b/iu.test(content)
    || /\bpackages\s*:\s*write\b/iu.test(content)) {
    throw new Error(`${path} contains a publication or write-capable step.`);
  }
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/mu.test(content)) {
    throw new Error(`${path} must declare read-only repository permissions.`);
  }
  if (!/persist-credentials:\s*false/u.test(content)) {
    throw new Error(`${path} must disable persisted checkout credentials.`);
  }
  const actionReferences = [...content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
  if (actionReferences.length === 0) throw new Error(`${path} contains no reviewable action references.`);
  for (const reference of actionReferences) {
    const separator = reference.lastIndexOf('@');
    const revision = separator < 0 ? '' : reference.slice(separator + 1);
    if (!/^[a-f0-9]{40}$/u.test(revision)) {
      throw new Error(`${path} action references must use full immutable commit SHAs.`);
    }
  }
};

const listTrackedFiles = () => execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: REPOSITORY_ROOT,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const readTrackedText = async () => {
  const entries = [];
  for (const path of listTrackedFiles()) {
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    entries.push({ content: await readFile(join(REPOSITORY_ROOT, path), 'utf8'), path });
  }
  return entries;
};

const checkSource = async () => {
  const entries = await readTrackedText();
  for (const entry of entries) {
    validateText(entry.path, entry.content);
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(entry.path)) {
      validateWorkflowPolicy(entry.path, entry.content);
    }
  }
  for (const path of listTrackedFiles().filter((value) => extname(value) === '.mjs')) {
    const result = spawnSync(process.execPath, ['--check', path], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      shell: false,
    });
    if (result.status !== 0) throw new Error(`JavaScript syntax check failed for ${path}.`);
  }

  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package-lock.json'), 'utf8'));
  if (packageJson.name !== PACKAGE_NAME
    || packageJson.version !== PACKAGE_VERSION
    || packageLock.name !== PACKAGE_NAME
    || packageLock.version !== PACKAGE_VERSION
    || packageLock.packages?.['']?.name !== PACKAGE_NAME
    || packageLock.packages?.['']?.version !== PACKAGE_VERSION) {
    throw new Error('Package identity is inconsistent across release metadata.');
  }
  process.stdout.write(`Checked ${entries.length} tracked text files and JavaScript syntax.\n`);
};

const checkSecrets = async () => {
  const entries = await readTrackedText();
  const findings = findPotentialSecrets(entries);
  if (findings.length > 0) {
    throw new Error(`Potential secrets detected: ${findings.map((item) => `${item.path} (${item.label})`).join(', ')}`);
  }
  process.stdout.write(`Checked ${entries.length} tracked text files for high-confidence secret patterns.\n`);
};

const readStandardInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const readTarString = (buffer) => buffer.toString('utf8').replace(/\0.*$/su, '');

const readTarOctal = (buffer, label) => {
  const raw = readTarString(buffer).trim();
  if (!/^[0-7]+$/u.test(raw)) throw new Error(`Tarball contains an invalid ${label}.`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Tarball contains an invalid ${label}.`);
  }
  return value;
};

const validateTarChecksum = (header) => {
  const expected = readTarOctal(header.subarray(148, 156), 'header checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error('Tarball header checksum is invalid.');
};

const normalizeTarPath = (path, { directory = false } = {}) => {
  const normalized = directory ? path.replace(/\/+$/u, '') : path;
  const segments = normalized.split('/');
  if (!(directory && normalized === 'package')
    && (!normalized.startsWith('package/')
      || normalized.includes('\\')
      || segments.some((segment) => !segment || segment === '.' || segment === '..'))) {
    throw new Error('Tarball contains an unsafe path.');
  }
  return normalized;
};

export const inspectTarball = (compressed) => {
  if (!Buffer.isBuffer(compressed) || compressed.length > MAX_COMPRESSED_TARBALL_BYTES) {
    throw new Error('Tarball exceeds the compressed artifact limit.');
  }
  const archive = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_TARBALL_BYTES });
  const files = new Map();
  const directories = new Set();
  let foundEnd = false;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const secondEnd = archive.subarray(offset + 512, offset + 1_024);
      if (secondEnd.length !== 512 || !secondEnd.every((byte) => byte === 0)
        || !archive.subarray(offset + 1_024).every((byte) => byte === 0)) {
        throw new Error('Tarball contains data after its end marker.');
      }
      foundEnd = true;
      break;
    }
    validateTarChecksum(header);
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(header.subarray(124, 136), 'entry size');
    const type = String.fromCharCode(header[156] || 0);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    const nextOffset = contentStart + Math.ceil(size / 512) * 512;
    if (contentEnd > archive.length || nextOffset > archive.length) {
      throw new Error('Tarball entry exceeds the archive boundary.');
    }
    if (type === '\0' || type === '0') {
      const packagePath = normalizeTarPath(path).slice('package/'.length);
      if (files.has(packagePath)) throw new Error('Tarball contains a duplicate file.');
      files.set(packagePath, archive.subarray(contentStart, contentEnd));
    } else if (type === '5') {
      const directory = normalizeTarPath(path, { directory: true });
      if (size !== 0 || !EXPECTED_PACKED_DIRECTORIES.has(directory)) {
        throw new Error('Tarball contains an unexpected directory entry.');
      }
      if (directories.has(directory)) throw new Error('Tarball contains a duplicate directory.');
      directories.add(directory);
    } else {
      throw new Error('Tarball contains a non-regular filesystem entry.');
    }
    offset = nextOffset;
  }
  if (!foundEnd) throw new Error('Tarball is missing its end marker.');
  const actual = [...files.keys()].sort();
  const expected = [...EXPECTED_PACKED_FILES].sort();
  if (!sameLists(actual, expected)) throw new Error('Tarball contents differ from the reviewed release allowlist.');
  return files;
};

const writeArtifactManifest = async (reportPath) => {
  const checkedReportPath = resolve(reportPath);
  const outputRoot = dirname(checkedReportPath);
  const report = JSON.parse(await readFile(checkedReportPath, 'utf8'));
  const entry = validatePackReport(report);
  const filename = basename(entry.filename);
  const tarballPath = resolve(outputRoot, filename);
  if (relative(outputRoot, tarballPath).startsWith('..')) throw new Error('Tarball path escaped its output directory.');
  const bytes = await readFile(tarballPath);
  const packedFiles = inspectTarball(bytes);
  const packedText = [...packedFiles].map(([path, content]) => ({
    content: content.toString('utf8'),
    path,
  }));
  const findings = findPotentialSecrets(packedText);
  if (findings.length > 0) throw new Error('Packed artifact contains a potential secret.');
  if (packedText.some((item) => /[A-Za-z]:\\Users\\|\/home\/[^/\s]+/u.test(item.content))) {
    throw new Error('Packed artifact contains a developer-local absolute path.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim();
  const manifest = {
    filename,
    integrity: entry.integrity,
    name: entry.name,
    sha256,
    sourceCommit,
    version: entry.version,
  };
  await writeFile(join(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(outputRoot, 'SHA256SUMS'), `${sha256}  ${filename}\n`, 'utf8');
  process.stdout.write(`Verified ${filename} (${packedFiles.size} files, SHA-256 ${sha256}).\n`);
};

const run = async () => {
  const command = process.argv[2];
  if (command === 'source') return checkSource();
  if (command === 'secrets') return checkSecrets();
  if (command === 'pack') {
    const entry = validatePackReport(JSON.parse(await readStandardInput()));
    process.stdout.write(`Verified dry-run package allowlist (${entry.entryCount} files).\n`);
    return;
  }
  if (command === 'artifact' && process.argv.length === 4) {
    return writeArtifactManifest(process.argv[3]);
  }
  if (command === 'revision') {
    const expected = process.env.RELEASE_COMMIT_SHA;
    if (!/^[a-f0-9]{40}$/u.test(expected ?? '')) throw new Error('Release candidate requires a full commit SHA.');
    const actual = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    }).trim();
    if (actual !== expected) throw new Error('Checked-out release candidate commit does not match approval input.');
    process.stdout.write(`Verified release candidate source commit ${actual}.\n`);
    return;
  }
  throw new Error('Unknown repository check command.');
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Repository check failed.'}\n`);
    process.exitCode = 1;
  }
}
