'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { physicalPath } = require('./filesystem-context');
const { normalizeDirectoryPath, readTextFile, writeTextFile } = require('./terminal-manager');

function validPath(value) {
  const result = normalizeDirectoryPath(value);
  if (!result) throw Object.assign(new Error('Invalid path'), { code: 'EINVAL' });
  return result;
}

function fingerprint(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

class FileService {
  constructor(config) { this.config = config; this.locks = new Map(); this.backupQueue = Promise.resolve(); }

  async locked(value, operation) {
    const key = await physicalPath(validPath(value));
    const previous = this.locks.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.locks.set(key, pending);
    try { return await pending; } finally { if (this.locks.get(key) === pending) this.locks.delete(key); }
  }

  backupPath(value) {
    return path.join(this.config.backupDir, crypto.createHash('sha256').update(validPath(value)).digest('hex'));
  }

  async backups(value) {
    const directory = this.backupPath(value);
    let names;
    try { names = await fs.promises.readdir(directory); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const items = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      try { items.push(JSON.parse(await fs.promises.readFile(path.join(directory, name), 'utf8'))); } catch {}
    }
    return items.sort((a, b) => b.id.localeCompare(a.id));
  }

  backup(value, buffer) {
    const pending = this.backupQueue.catch(() => {}).then(() => this.createBackup(value, buffer));
    this.backupQueue = pending;
    return pending;
  }

  async createBackup(value, buffer) {
    if (!this.config.backupCount) return;
    const directory = this.backupPath(value);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const dataPath = path.join(directory, `${id}.data`);
    try {
      if (buffer) await fs.promises.writeFile(dataPath, buffer, { flag: 'wx', mode: 0o600 });
      else { await fs.promises.copyFile(await physicalPath(value), dataPath, fs.constants.COPYFILE_EXCL); await fs.promises.chmod(dataPath, 0o600); }
      const stat = await fs.promises.stat(dataPath);
      await fs.promises.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, path: value, size: stat.size, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      const items = await this.backups(value);
      for (const item of items.slice(this.config.backupCount)) await this.removeBackup(directory, item.id);
      await this.pruneTotal();
    } catch (error) {
      await fs.promises.unlink(dataPath).catch(() => {});
      throw error;
    }
  }

  async removeBackup(directory, id) {
    await fs.promises.unlink(path.join(directory, `${id}.data`)).catch(() => {});
    await fs.promises.unlink(path.join(directory, `${id}.json`)).catch(() => {});
  }

  async pruneTotal() {
    const files = [];
    for (const folder of await fs.promises.readdir(this.config.backupDir)) {
      if (!/^[a-f0-9]{64}$/.test(folder)) continue;
      const directory = path.join(this.config.backupDir, folder);
      for (const name of await fs.promises.readdir(directory)) {
        if (!name.endsWith('.data')) continue;
        const stat = await fs.promises.stat(path.join(directory, name)).catch(() => null);
        if (stat) files.push({ directory, id: name.slice(0, -5), size: stat.size, time: stat.mtimeMs });
      }
    }
    let total = files.reduce((sum, item) => sum + item.size, 0);
    for (const item of files.sort((a, b) => a.time - b.time)) {
      if (total <= this.config.backupMaxBytes) break;
      await this.removeBackup(item.directory, item.id);
      total -= item.size;
    }
  }

  async backupContent(value, id) {
    if (!/^\d+-[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error('Invalid backup'), { code: 'EINVAL' });
    const dataPath = path.join(this.backupPath(value), `${id}.data`);
    const stat = await fs.promises.stat(dataPath);
    if (stat.size > this.config.maxFileBytes) throw Object.assign(new Error('Backup is too large for the editor'), { code: 'EFBIG' });
    const buffer = await fs.promises.readFile(dataPath);
    const content = buffer.toString('utf8');
    if (buffer.includes(0) || !Buffer.from(content).equals(buffer)) throw Object.assign(new Error('Backup is not UTF-8 text'), { code: 'EILSEQ' });
    return { path: value, id, content, size: buffer.length };
  }

  write(value, content, expectedVersion) {
    return this.locked(value, () => writeTextFile(value, content, expectedVersion, this.config.maxFileBytes, (filePath, buffer) => this.backup(filePath, buffer)));
  }

  async restore(value, id, expectedVersion) {
    const previous = await this.backupContent(value, id);
    return this.write(value, previous.content, expectedVersion);
  }

  async metadata(value) {
    const filePath = validPath(value);
    const diskPath = await physicalPath(filePath);
    const stat = await fs.promises.stat(diskPath);
    const link = await fs.promises.lstat(await physicalPath(filePath, false));
    return { path: filePath, size: stat.size, mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'), uid: stat.uid, gid: stat.gid,
      modifiedAt: stat.mtime.toISOString(), fingerprint: fingerprint(stat), type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      linkTarget: link.isSymbolicLink() ? await fs.promises.readlink(await physicalPath(filePath, false)) : null };
  }

  async directorySize(value, signal) {
    const directory = await physicalPath(validPath(value));
    const rootStat = await fs.promises.stat(directory);
    if (!rootStat.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
    const pending = [directory]; let size = 0; let entries = 0; let skipped = 0; const started = Date.now();
    while (pending.length) {
      const folder = pending.pop();
      let handle;
      try { handle = await fs.promises.opendir(folder); } catch { skipped++; continue; }
      try {
        for await (const item of handle) {
          if (signal.aborted) throw Object.assign(new Error('Calculation cancelled'), { code: 'ECANCELED' });
          if (++entries > 20000 || Date.now() - started > 10000) return { path: value, size, entries, skipped, partial: true };
          if (item.isSymbolicLink()) continue;
          const diskPath = path.join(folder, item.name);
          try {
            const stat = await fs.promises.lstat(diskPath);
            if (stat.dev !== rootStat.dev) { skipped++; continue; }
            if (stat.isDirectory()) pending.push(diskPath);
            else if (stat.isFile()) size += stat.size;
          } catch { skipped++; }
        }
      } finally { await handle.close().catch(() => {}); }
    }
    return { path: value, size, entries, skipped, partial: skipped > 0 };
  }

  async upload(value, req, overwrite, expectedFingerprint) {
    return this.locked(value, async () => {
      const filePath = validPath(value);
      const diskPath = await physicalPath(filePath);
      const temporary = path.join(path.dirname(diskPath), `.ws-terminal-upload-${crypto.randomUUID()}`);
      let bytes = 0;
      const counter = new Transform({ transform: (chunk, encoding, callback) => {
        bytes += chunk.length;
        callback(bytes > this.config.maxTransferBytes ? Object.assign(new Error('Transfer size limit exceeded'), { code: 'EFBIG' }) : null, chunk);
      } });
      try {
        await pipeline(req, counter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (overwrite) {
          const stat = await fs.promises.stat(diskPath);
          if (!stat.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'EISDIR' });
          if (!expectedFingerprint || fingerprint(stat) !== expectedFingerprint) throw Object.assign(new Error('File changed on disk'), { code: 'ESTALE' });
          if (stat.size > this.config.maxTransferBytes) throw Object.assign(new Error('Existing file exceeds backup limit'), { code: 'EFBIG' });
          const handle = await fs.promises.open(diskPath, 'r+');
          try {
            if (fingerprint(await handle.stat()) !== expectedFingerprint) throw Object.assign(new Error('File changed on disk'), { code: 'ESTALE' });
            await this.backup(filePath);
            if (fingerprint(await handle.stat()) !== expectedFingerprint) throw Object.assign(new Error('File changed on disk'), { code: 'ESTALE' });
            let position = 0;
            for await (const chunk of fs.createReadStream(temporary)) {
              let offset = 0;
              while (offset < chunk.length) {
                const result = await handle.write(chunk, offset, chunk.length - offset, position);
                if (!result.bytesWritten) throw Object.assign(new Error('Upload write made no progress'), { code: 'EIO' });
                offset += result.bytesWritten;
                position += result.bytesWritten;
              }
            }
            await handle.truncate(position);
            await handle.sync();
          } finally { await handle.close(); }
        } else {
          await fs.promises.link(temporary, diskPath);
        }
        return { path: filePath, size: bytes, operation: 'upload' };
      } finally { await fs.promises.unlink(temporary).catch(() => {}); }
    });
  }

  async download(value, req, res) {
    const filePath = validPath(value);
    const handle = await fs.promises.open(await physicalPath(filePath), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'EISDIR' });
      if (stat.size > this.config.maxTransferBytes) throw Object.assign(new Error('Transfer size limit exceeded'), { code: 'EFBIG' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(filePath))}` });
      await pipeline(handle.createReadStream({ autoClose: false }), res);
      return { path: filePath, size: stat.size, operation: 'download' };
    } finally { await handle.close(); }
  }
}

module.exports = { FileService, fingerprint, validPath };
