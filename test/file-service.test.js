'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { FileService } = require('../server/src/file-service');
const { readTextFile } = require('../server/src/terminal-manager');
const { physicalPath } = require('../server/src/filesystem-context');

async function fixture(run) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-terminal-service-'));
  const service = new FileService({ backupDir: path.join(folder, 'history'), backupCount: 2, backupMaxBytes: 1024 * 1024,
    maxFileBytes: 4096, maxTransferBytes: 8192 });
  try { await run(service, folder); } finally { await fs.rm(folder, { recursive: true, force: true }); }
}

test('backs up exact UTF-8 BOM and CRLF bytes, restores with conflict protection, and bounds history', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  const file = path.join(folder, 'hosts');
  const original = '\uFEFFfirst\r\n\r\n';
  await fs.writeFile(file, original);
  const initial = await readTextFile(file, 4096);
  const changed = await service.write(file, 'second\n', initial.version);
  let history = await service.backups(file);
  assert.equal(history.length, 1);
  assert.equal((await service.backupContent(file, history[0].id)).content, original);
  const restored = await service.restore(file, history[0].id, changed.version);
  assert.equal(restored.content, original);
  await assert.rejects(service.write(file, 'lost', changed.version), { code: 'ESTALE' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await service.write(file, 'third\n', restored.version);
  history = await service.backups(file);
  assert.equal(history.length, 2);
  await assert.rejects(service.backupContent(file, '../hosts'), { code: 'EINVAL' });
}));

test('serializes conflicting concurrent saves without losing the winning edit', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  const file = path.join(folder, 'note.txt'); await fs.writeFile(file, 'original');
  const initial = await readTextFile(file, 4096);
  const outcomes = await Promise.allSettled([service.write(file, 'winner', initial.version), service.write(file, 'loser', initial.version)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes[1].reason.code, 'ESTALE'); assert.equal(await fs.readFile(file, 'utf8'), 'winner');
}));

test('streams binary uploads, rejects duplicate names and stale overwrites, cleans incomplete transfers', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  const file = path.join(folder, 'binary.dat'); const content = Buffer.from([0, 1, 2, 255]);
  await service.upload(file, Readable.from([content]), false);
  await fs.chmod(file, 0o640);
  assert.deepEqual(await fs.readFile(file), content);
  await assert.rejects(service.upload(file, Readable.from(['duplicate']), false), { code: 'EEXIST' });
  const metadata = await service.metadata(file);
  await fs.writeFile(file, 'external');
  await assert.rejects(service.upload(file, Readable.from(['overwrite']), true, metadata.fingerprint), { code: 'ESTALE' });
  const updated = await service.metadata(file);
  const before = await fs.stat(file);
  await service.upload(file, Readable.from(['overwrite']), true, updated.fingerprint);
  assert.equal(await fs.readFile(file, 'utf8'), 'overwrite');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  const after = await fs.stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal((await service.backups(file)).length, 1);
  await assert.rejects(service.upload(path.join(folder, 'too-large'), Readable.from([Buffer.alloc(8193)]), false), { code: 'EFBIG' });
  assert.equal((await fs.readdir(folder)).some(name => name.startsWith('.ws-terminal-upload-')), false);
}));

test('resolves absolute and relative host symlinks in the host root and rejects loops', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  await fs.mkdir(path.join(folder, 'usr')); await fs.mkdir(path.join(folder, 'usr/bin'));
  await fs.writeFile(path.join(folder, 'usr/bin/tool'), 'host-tool');
  await fs.symlink('/usr/bin', path.join(folder, 'bin'));
  await fs.symlink('usr/bin', path.join(folder, 'relative'));
  assert.equal(await physicalPath('/bin/tool', true, folder), path.join(folder, 'usr/bin/tool'));
  assert.equal(await physicalPath('/relative/new-tool', true, folder), path.join(folder, 'usr/bin/new-tool'));
  assert.equal(await physicalPath('/bin', false, folder), path.join(folder, 'bin'));
  await fs.symlink('/loop', path.join(folder, 'loop'));
  await assert.rejects(physicalPath('/loop', true, folder), { code: 'ELOOP' });
}));

test('directory size is on demand, includes nested and hidden files, and supports cancellation', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  const target = path.join(folder, 'size-test'); await fs.mkdir(target); await fs.mkdir(path.join(target, 'nested'));
  await fs.writeFile(path.join(target, 'first'), '1234'); await fs.writeFile(path.join(target, 'nested/.hidden'), '123');
  await fs.symlink(target, path.join(target, 'loop'));
  const result = await service.directorySize(target, new AbortController().signal);
  assert.equal(result.size, 7); assert.equal(result.partial, false);
  const controller = new AbortController(); controller.abort(); await assert.rejects(service.directorySize(target, controller.signal), { code: 'ECANCELED' });
}));
