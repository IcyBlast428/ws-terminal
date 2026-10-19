'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { physicalPath } = require('./filesystem-context');
const { normalizeDirectoryPath, validateEntryName, deleteEntry } = require('./terminal-manager');

const run = promisify(execFile);
const fail = (message, code = 'EINVAL') => Object.assign(new Error(message), { code });
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

async function directoryIdentity(value) {
  const handle = await fs.open(value, constants.O_RDONLY | constants.O_DIRECTORY);
  try { return { path: await fs.readlink(`/proc/self/fd/${handle.fd}`), stat: await handle.stat() }; }
  finally { await handle.close(); }
}

function valid(value) {
  const result = normalizeDirectoryPath(value);
  if (!result || result === '/') throw fail('The filesystem root cannot be copied, moved or deleted');
  return result.replace(/\/+$/, '');
}

// GNU mv uses a no-replace rename on Linux; never interpolate paths into a shell.
async function moveExclusive(source, target) {
  const original = await fs.lstat(source);
  if (original.dev !== (await fs.stat(path.dirname(target))).dev) throw fail('Cross-filesystem moves are not supported; copy first', 'EXDEV');
  await run('/usr/bin/mv', ['--no-clobber', '--no-target-directory', '--', source, target], { timeout: 30000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  const remaining = await fs.lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (remaining) throw fail('Destination already exists; nothing was overwritten', 'EEXIST');
  const moved = await fs.lstat(target);
  if (moved.dev !== original.dev || moved.ino !== original.ino) throw fail('Move could not be verified', 'ESTALE');
}

class FileOperations {
  constructor(config) { this.config = config; this.queue = Promise.resolve(); }

  batch(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return Promise.reject(fail('Invalid file operation'));
    const operation = this.queue.catch(() => {}).then(() => this.perform(payload));
    this.queue = operation;
    return operation;
  }

  async perform({ operation, paths, destination }) {
    if (!['copy', 'move', 'duplicate', 'delete'].includes(operation) || !Array.isArray(paths) || !paths.length || paths.length > 100) throw fail('Select between 1 and 100 entries');
    const selected = [...new Set(paths.map(valid))];
    const sources = selected.filter(value => !selected.some(parent => parent !== value && value.startsWith(`${parent}/`)));
    let targetDirectory;
    if (operation === 'copy' || operation === 'move') {
      targetDirectory = normalizeDirectoryPath(destination);
      if (!targetDirectory || !(await fs.stat(await physicalPath(targetDirectory))).isDirectory()) throw fail('Destination is not a directory', 'ENOTDIR');
    }
    const results = [];
    const budget = { started: Date.now(), entries: 0, bytes: 0 };
    for (const source of sources) {
      try {
        if (operation === 'delete') { await deleteEntry(source); results.push({ path: source, ok: true }); continue; }
        const diskSource = await physicalPath(source, false);
        const parent = operation === 'duplicate' ? path.posix.dirname(source) : targetDirectory;
        const diskParent = await physicalPath(parent);
        const sourceStat = await fs.lstat(diskSource);
        if (sourceStat.isDirectory()) {
          // procfs magic links must be resolved by the kernel, not in the container root.
          const realSource = await directoryIdentity(diskSource);
          const realParent = await directoryIdentity(diskParent);
          if ((realParent.stat.dev === realSource.stat.dev && realParent.stat.ino === realSource.stat.ino) || realParent.path.startsWith(`${realSource.path}/`)) throw fail('Cannot copy or move a directory into itself');
        }
        let name = path.posix.basename(source);
        if (operation === 'duplicate') name = await this.copyName(diskParent, name, sourceStat.isDirectory());
        const target = path.posix.join(parent, name);
        const diskTarget = path.join(diskParent, name);
        if (await fs.lstat(diskTarget).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; })) throw fail('Destination already exists; nothing was overwritten', 'EEXIST');
        if (operation === 'move') await moveExclusive(diskSource, diskTarget);
        else await this.copy(diskSource, diskTarget, budget);
        results.push({ path: source, newPath: target, ok: true });
      } catch (error) { results.push({ path: source, ok: false, error: error.message, code: error.code || 'EIO' }); }
    }
    return { operation, results };
  }

  async copyName(parent, name, directory) {
    const extension = directory ? '' : path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let index = 1; index <= 1000; index++) {
      const candidate = `${stem} copy${index === 1 ? '' : ` ${index}`}${extension}`;
      validateEntryName(candidate);
      try { await fs.lstat(path.join(parent, candidate)); } catch (error) { if (error.code === 'ENOENT') return candidate; throw error; }
    }
    throw fail('Too many duplicate names', 'EEXIST');
  }

  async copy(source, target, budget) {
    const maximum = this.config.maxCopyEntries || 10000;
    const maxBytes = this.config.maxTransferBytes;
    const started = budget.started;
    const entries = [];
    const pending = [{ source, relative: '' }];
    const rootDevice = (await fs.lstat(source)).dev;
    const destinationParent = await fs.stat(path.dirname(target));
    while (pending.length) {
      if (++budget.entries > maximum || Date.now() - started > 30000) throw fail('Copy scan limit exceeded', 'EFBIG');
      const item = pending.pop();
      const stat = await fs.lstat(item.source);
      if (stat.isDirectory() && stat.dev === destinationParent.dev && stat.ino === destinationParent.ino) throw fail('Cannot copy a directory into itself through an alias');
      if (stat.dev !== rootDevice) throw fail('Copy does not traverse mounted filesystems', 'EXDEV');
      if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw fail('Special files cannot be copied');
      if (stat.isFile() && (budget.bytes += stat.size) > maxBytes) throw fail('Copy exceeds the transfer size limit', 'EFBIG');
      entries.push({ ...item, stat });
      if (stat.isDirectory()) {
        const directory = await fs.opendir(item.source);
        for await (const child of directory) {
          if (entries.length + pending.length >= maximum) throw fail('Copy entry limit exceeded', 'EFBIG');
          pending.push({ source: path.join(item.source, child.name), relative: path.join(item.relative, child.name) });
        }
      }
    }
    const temporary = await fs.mkdtemp(path.join(path.dirname(target), '.ws-terminal-copy-'));
    const staged = path.join(temporary, 'entry');
    try {
      for (const item of entries) {
        if (Date.now() - started > 30000) throw fail('Copy time limit exceeded', 'EFBIG');
        if (identity(await fs.lstat(item.source)) !== identity(item.stat)) throw fail('Source changed during copy', 'ESTALE');
        const output = path.join(staged, item.relative);
        if (item.stat.isDirectory()) await fs.mkdir(output, { mode: 0o700 });
        else if (item.stat.isSymbolicLink()) await fs.symlink(await fs.readlink(item.source), output);
        else {
          const input = await fs.open(item.source, constants.O_RDONLY | constants.O_NOFOLLOW);
          let destination;
          try {
            destination = await fs.open(output, 'wx', 0o600);
            if (identity(await input.stat()) !== identity(item.stat)) throw fail('Source changed during copy', 'ESTALE');
            const buffer = Buffer.alloc(65536); let position = 0;
            while (position < item.stat.size) {
              const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, item.stat.size - position), position);
              if (!bytesRead) throw fail('Source changed during copy', 'ESTALE');
              let offset = 0;
              while (offset < bytesRead) { const written = await destination.write(buffer, offset, bytesRead - offset, position + offset); if (!written.bytesWritten) throw fail('Copy write failed', 'EIO'); offset += written.bytesWritten; }
              position += bytesRead;
              if (Date.now() - started > 30000) throw fail('Copy time limit exceeded', 'EFBIG');
            }
            if (identity(await input.stat()) !== identity(item.stat)) throw fail('Source changed during copy', 'ESTALE');
            await destination.sync();
            await destination.chmod(item.stat.mode & 0o777);
          } finally { await input.close(); await destination?.close(); }
        }
      }
      for (const item of entries.slice().reverse()) if (item.stat.isDirectory()) await fs.chmod(path.join(staged, item.relative), item.stat.mode & 0o777);
      await moveExclusive(staged, target);
    } finally {
      // This private staging directory is created by us and never contains followed links.
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

module.exports = { FileOperations };
