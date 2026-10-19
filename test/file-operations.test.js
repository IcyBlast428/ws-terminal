'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileService } = require('../server/src/file-service');
const { topLevelPaths, breadcrumbs } = require('../public/assets/workbench-model');

async function fixture(run) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-terminal-operations-'));
  const service = new FileService({ maxFileBytes: 4096, maxTransferBytes: 8192, maxCopyEntries: 20 });
  try { await run(service, folder); } finally { await fs.rm(folder, { recursive: true, force: true }); }
}

test('selection collapses descendants, breadcrumbs preserve real paths', () => {
  assert.deepEqual(topLevelPaths(['/tmp/a/child', '/tmp/a', '/tmp/a', '/tmp/ab']), ['/tmp/a', '/tmp/ab']);
  assert.deepEqual(breadcrumbs('/etc/nginx'), [{ name: '/', path: '/' }, { name: 'etc', path: '/etc' }, { name: 'nginx', path: '/etc/nginx' }]);
});

test('save as is exclusive, byte-exact, bounded and does not follow an existing symlink', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  const target = `${folder}/saved`; const content = '\uFEFFone\r\n\r\n';
  assert.equal((await service.saveAs(target, content)).content, content);
  await assert.rejects(service.saveAs(target, 'overwrite'), { code: 'EEXIST' });
  await assert.rejects(service.saveAs(`${folder}/large`, 'x'.repeat(4097)), { code: 'EFBIG' });
  await fs.symlink(`${folder}/absent`, `${folder}/link`);
  await assert.rejects(service.saveAs(`${folder}/link`, 'follow'), { code: 'EEXIST' });
  await assert.rejects(fs.stat(`${folder}/absent`), { code: 'ENOENT' });
  assert.equal(await fs.readFile(target, 'utf8'), content);
}));

test('batch copies nested hidden files and symbolic links without following them, and duplicates with fresh names', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  const source = `${folder}/source`; const destination = `${folder}/dest`;
  await fs.mkdir(source); await fs.mkdir(destination); await fs.mkdir(`${source}/nested`);
  await fs.writeFile(`${source}/nested/.hidden`, 'secret'); await fs.symlink('/no-such-target', `${source}/link`);
  const result = await service.operations.batch({ operation: 'copy', paths: [source, `${source}/nested`], destination });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].ok, true);
  assert.equal(await fs.readFile(`${destination}/source/nested/.hidden`, 'utf8'), 'secret');
  assert.equal(await fs.readlink(`${destination}/source/link`), '/no-such-target');
  assert.equal((await service.operations.batch({ operation: 'copy', paths: [source], destination })).results[0].code, 'EEXIST');
  const duplicate = await service.operations.batch({ operation: 'duplicate', paths: [source] });
  assert.equal(duplicate.results[0].newPath, `${folder}/source copy`);
  const another = await service.operations.batch({ operation: 'duplicate', paths: [source] });
  assert.equal(another.results[0].newPath, `${folder}/source copy 2`);
}));

test('move preserves inode, reports partial failure, and refuses root, descendant and nonempty deletes', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  const source = `${folder}/source`; const destination = `${folder}/dest`;
  await fs.mkdir(source); await fs.mkdir(destination); await fs.writeFile(`${source}/note`, 'one');
  const before = await fs.stat(`${source}/note`);
  const moved = await service.operations.batch({ operation: 'move', paths: [`${source}/note`, `${source}/missing`], destination });
  assert.equal(moved.results[0].ok, true); assert.equal(moved.results[1].code, 'ENOENT');
  assert.equal((await fs.stat(`${destination}/note`)).ino, before.ino);
  await fs.writeFile(`${source}/note`, 'keep');
  assert.equal((await service.operations.batch({ operation: 'move', paths: [`${source}/note`], destination })).results[0].code, 'EEXIST');
  assert.equal(await fs.readFile(`${source}/note`, 'utf8'), 'keep');
  assert.equal((await service.operations.batch({ operation: 'copy', paths: [source], destination: source })).results[0].code, 'EINVAL');
  await fs.symlink(source, `${folder}/alias`);
  assert.equal((await service.operations.batch({ operation: 'move', paths: [source], destination: `${folder}/alias` })).results[0].code, 'EINVAL');
  assert.equal((await service.operations.batch({ operation: 'delete', paths: [source] })).results[0].code, 'ENOTEMPTY');
  await assert.rejects(service.operations.batch({ operation: 'delete', paths: ['/'] }), { code: 'EINVAL' });
  await assert.rejects(service.operations.batch(null), { code: 'EINVAL' });
}));

test('copy bounds combined bytes and entries and removes private staging on errors', { skip: process.platform !== 'linux' }, async () => fixture(async (service, folder) => {
  await fs.mkdir(`${folder}/dest`); await fs.writeFile(`${folder}/a`, 'a'.repeat(5000)); await fs.writeFile(`${folder}/b`, 'b'.repeat(5000));
  const result = await service.operations.batch({ operation: 'copy', paths: [`${folder}/a`, `${folder}/b`], destination: `${folder}/dest` });
  assert.equal(result.results[0].ok, true); assert.equal(result.results[1].code, 'EFBIG');
  service.operations.config.maxCopyEntries = 1;
  assert.equal((await service.operations.batch({ operation: 'duplicate', paths: [`${folder}/dest`] })).results[0].code, 'EFBIG');
  assert.equal((await fs.readdir(folder)).some(name => name.startsWith('.ws-terminal-copy-')), false);
  assert.equal((await fs.readdir(`${folder}/dest`)).some(name => name.startsWith('.ws-terminal-copy-')), false);
}));
