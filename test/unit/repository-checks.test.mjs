import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import {
  EXPECTED_PACKED_FILES,
  findPotentialSecrets,
  inspectTarball,
  validatePackReport,
  validateText,
  validateWorkflowPolicy,
} from '../../scripts/repository-checks.mjs';

const packReport = () => [{
  bundled: [],
  entryCount: EXPECTED_PACKED_FILES.length,
  files: EXPECTED_PACKED_FILES.map((path) => ({ path, size: 1 })),
  integrity: 'sha512-test',
  name: '@bookarium/codex-connector',
  version: '0.1.0',
}];

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;
const tarEntry = (path, content = Buffer.from('x'), type = '0') => {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(content.length, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = [...header].reduce((total, byte) => total + byte, 0);
  header.write(octal(checksum, 8), 148, 8, 'ascii');
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  return Buffer.concat([header, content, padding]);
};

const validTarball = () => gzipSync(Buffer.concat([
  ...EXPECTED_PACKED_FILES.map((path) => tarEntry(`package/${path}`)),
  Buffer.alloc(1_024),
]));

test('requires the exact reviewed npm package file allowlist', () => {
  assert.equal(validatePackReport(packReport()).entryCount, EXPECTED_PACKED_FILES.length);
  const extra = packReport();
  extra[0].files.push({ path: 'auth.json', size: 1 });
  extra[0].entryCount += 1;
  assert.throws(() => validatePackReport(extra), /allowlist/u);
  const bundled = packReport();
  bundled[0].bundled.push('unexpected');
  assert.throws(() => validatePackReport(bundled), /identity|dependency/u);
});

test('inspects compressed tar contents and rejects non-regular entries', () => {
  assert.equal(inspectTarball(validTarball()).size, EXPECTED_PACKED_FILES.length);
  const archive = Buffer.concat([
    tarEntry(`package/${EXPECTED_PACKED_FILES[0]}`, Buffer.from('x'), '2'),
    Buffer.alloc(1_024),
  ]);
  assert.throws(() => inspectTarball(gzipSync(archive)), /non-regular/u);
});

test('rejects unsafe directories, invalid checksums, and trailing archive data', () => {
  const unsafeDirectory = gzipSync(Buffer.concat([
    tarEntry('package/../../escape', Buffer.alloc(0), '5'),
    ...EXPECTED_PACKED_FILES.map((path) => tarEntry(`package/${path}`)),
    Buffer.alloc(1_024),
  ]));
  assert.throws(() => inspectTarball(unsafeDirectory), /unsafe path/u);

  const invalidChecksum = Buffer.concat([
    ...EXPECTED_PACKED_FILES.map((path) => tarEntry(`package/${path}`)),
    Buffer.alloc(1_024),
  ]);
  invalidChecksum[0] ^= 1;
  assert.throws(() => inspectTarball(gzipSync(invalidChecksum)), /checksum/u);

  const trailingData = gzipSync(Buffer.concat([
    ...EXPECTED_PACKED_FILES.map((path) => tarEntry(`package/${path}`)),
    Buffer.alloc(1_024),
    Buffer.from('hidden'),
  ]));
  assert.throws(() => inspectTarball(trailingData), /after its end/u);
});

test('detects high-confidence secret formats without embedding a credential fixture', () => {
  const fakeToken = ['ghp', '_', 'A'.repeat(36)].join('');
  assert.deepEqual(findPotentialSecrets([{ content: fakeToken, path: 'fixture.txt' }]), [{
    label: 'GitHub token',
    path: 'fixture.txt',
  }]);
  assert.deepEqual(findPotentialSecrets([{ content: 'ordinary documentation', path: 'README.md' }]), []);
});

test('enforces LF text and read-only immutable workflow references', () => {
  assert.doesNotThrow(() => validateText('ok.mjs', 'const ok = true;\n'));
  assert.throws(() => validateText('bad.mjs', 'const bad = true; \n'), /trailing/u);
  const workflow = `permissions:\n  contents: read\nsteps:\n  - uses: actions/checkout@${'a'.repeat(40)}\n    with:\n      persist-credentials: false\n`;
  assert.doesNotThrow(() => validateWorkflowPolicy('ci.yml', workflow));
  assert.throws(() => validateWorkflowPolicy('ci.yml', workflow.replace('a'.repeat(40), 'v6')), /immutable/u);
  assert.throws(() => validateWorkflowPolicy('ci.yml', `${workflow}  - run: npm publish\n`), /publication/u);
});
