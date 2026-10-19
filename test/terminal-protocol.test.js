'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createEntry,
  deleteEntry,
  formatDirectoryEntries,
  listDirectory,
  normalizeDirectoryPath,
  parseClientMessage,
  readTextFile,
  renameEntry,
  validateEntryName,
  writeTextFile
} = require('../server/src/terminal-manager');

test('rejects null, arrays, and malformed JSON without throwing', () => {
  assert.equal(parseClientMessage(Buffer.from('null'), 1024), null);
  assert.equal(parseClientMessage(Buffer.from('[]'), 1024), null);
  assert.equal(parseClientMessage(Buffer.from('{'), 1024), null);
});

test('accepts protocol objects and flags oversized input', () => {
  assert.deepEqual(
    parseClientMessage(Buffer.from('{"type":"resize","cols":120,"rows":40}'), 1024),
    { type: 'resize', cols: 120, rows: 40 }
  );
  assert.deepEqual(parseClientMessage(Buffer.from('{"type":"close"}'), 1024), { type: 'close' });
  assert.deepEqual(parseClientMessage(Buffer.alloc(10), 5), { error: 'input too large' });
});

test('normalizes absolute Linux directory paths and rejects unsafe values', () => {
  assert.equal(normalizeDirectoryPath('/var/../root/./work'), '/root/work');
  assert.equal(normalizeDirectoryPath('/'), '/');
  assert.equal(normalizeDirectoryPath('relative/path'), null);
  assert.equal(normalizeDirectoryPath('/tmp\0hidden'), null);
});

test('sorts directories before files and applies the listing limit', () => {
  const dirent = (name, type) => ({
    name,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => type === 'symlink'
  });
  const result = formatDirectoryEntries('/root', [
    dirent('.hidden', 'file'),
    dirent('z.txt', 'file'),
    dirent('beta', 'directory'),
    dirent('alpha', 'directory')
  ], 2);
  assert.deepEqual(result.entries, [
      { name: 'alpha', path: '/root/alpha', type: 'directory' },
      { name: 'beta', path: '/root/beta', type: 'directory' }
    ]);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 3);
  assert.equal(result.nextOffset, 2);
});

test('directory listings include regular file sizes without scanning directory totals', { skip: process.platform === 'win32' }, async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ws-terminal-list-'));
  const posixDirectory = directory.replaceAll('\\', '/');
  try {
    await fs.promises.mkdir(path.join(directory, 'nested'));
    await fs.promises.writeFile(path.join(directory, 'note.txt'), '1234567', 'utf8');
    const result = await listDirectory(posixDirectory, 20);
    const file = result.entries.find((entry) => entry.name === 'note.txt');
    const nested = result.entries.find((entry) => entry.name === 'nested');
    assert.equal(file.size, 7);
    assert.equal(Object.hasOwn(nested, 'size'), false);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('allows hidden names but rejects traversal and unsafe entry names', () => {
  assert.equal(validateEntryName('notes.txt'), 'notes.txt');
  assert.equal(validateEntryName('.env'), '.env');
  assert.equal(validateEntryName('.gitignore'), '.gitignore');
  for (const name of ['', '.', '..', 'nested/name', 'nested\\name', 'bad\0name']) {
    assert.throws(() => validateEntryName(name), { code: 'EINVAL' });
  }
});

test('pages and searches all directory entries with revision protection', () => {
  const entries = Array.from({ length: 750 }, (_, index) => ({ name: `file-${String(index).padStart(4, '0')}`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }));
  const first = formatDirectoryEntries('/data', entries, 500);
  const second = formatDirectoryEntries('/data', entries, 500, false, { offset: first.nextOffset, revision: first.revision });
  assert.equal(first.entries.length, 500); assert.equal(second.entries.length, 250); assert.equal(second.truncated, false);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size, 750);
  assert.equal(formatDirectoryEntries('/data', entries, 500, false, { query: 'FILE-0749' }).entries[0].name, 'file-0749');
  assert.throws(() => formatDirectoryEntries('/data', entries.slice(1), 500, false, { offset: 500, revision: first.revision }), { code: 'ESTALE' });
  assert.throws(() => formatDirectoryEntries('/data', entries, 500, false, { offset: -1 }), { code: 'EINVAL' });
});

test('reads UTF-8 text and rejects binary or oversized files', { skip: process.platform === 'win32' }, async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ws-terminal-test-'));
  const textPath = path.join(directory, 'hello.txt');
  const binaryPath = path.join(directory, 'binary.dat');
  const largePath = path.join(directory, 'large.txt');
  try {
    await fs.promises.writeFile(textPath, 'hello\n世界\n', 'utf8');
    await fs.promises.writeFile(binaryPath, Buffer.from([1, 0, 2]));
    await fs.promises.writeFile(largePath, 'x'.repeat(64), 'utf8');
    const result = await readTextFile(textPath.replaceAll('\\', '/'), 1024);
    assert.equal(result.content, 'hello\n世界\n');
    assert.equal(result.size, Buffer.byteLength(result.content));
    assert.match(result.version, /^[a-f0-9]{64}$/);
    await assert.rejects(readTextFile(binaryPath.replaceAll('\\', '/'), 1024), { code: 'EISBINARY' });
    await assert.rejects(readTextFile(largePath.replaceAll('\\', '/'), 32), { code: 'EFBIG' });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('creates, saves, renames, and deletes entries with conflict protection', { skip: process.platform === 'win32' }, async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ws-terminal-mutate-'));
  const posixDirectory = directory.replaceAll('\\', '/');
  try {
    const createdDirectory = await createEntry(posixDirectory, 'docs', 'directory');
    const createdFile = await createEntry(createdDirectory.path, 'note.txt', 'file');
    const initial = await readTextFile(createdFile.path, 1024);
    const saved = await writeTextFile(createdFile.path, 'edited\n', initial.version, 1024);
    assert.equal(saved.content, 'edited\n');

    await fs.promises.writeFile(createdFile.path, 'changed elsewhere\n', 'utf8');
    await assert.rejects(writeTextFile(createdFile.path, 'overwrite\n', saved.version, 1024), { code: 'ESTALE' });

    const renamed = await renameEntry(createdFile.path, 'renamed.txt');
    assert.equal(await fs.promises.readFile(renamed.newPath, 'utf8'), 'changed elsewhere\n');
    await assert.rejects(deleteEntry(createdDirectory.path), { code: 'ENOTEMPTY' });
    await deleteEntry(renamed.newPath);
    await deleteEntry(createdDirectory.path);
    await assert.rejects(fs.promises.access(createdDirectory.path));
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
