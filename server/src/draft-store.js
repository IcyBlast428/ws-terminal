'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeDirectoryPath } = require('./terminal-manager');

class DraftStore {
  constructor(config) {
    this.config = config;
    this.queue = Promise.resolve();
    this.ready = null;
  }

  async initialize() {
    await fs.mkdir(this.config.draftDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.draftDir, 0o700);
    const keyPath = path.join(this.config.draftDir, '.key');
    try { await fs.writeFile(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await fs.chmod(keyPath, 0o600);
    const key = await fs.readFile(keyPath);
    if (key.length !== 32) throw new Error('Draft encryption key is invalid');
    return key;
  }

  exclusive(operation) {
    const pending = this.queue.catch(() => {}).then(async () => {
      this.ready ||= this.initialize();
      return operation(await this.ready);
    });
    this.queue = pending;
    return pending;
  }

  prefix(vault) {
    if (typeof vault !== 'string' || !/^[a-f0-9]{64}$/.test(vault)) throw Object.assign(new Error('Invalid draft vault'), { code: 'EINVAL' });
    return crypto.createHash('sha256').update(vault).digest('hex') + '-';
  }

  filename(vault, value) {
    const filePath = normalizeDirectoryPath(value);
    if (!filePath) throw Object.assign(new Error('Invalid draft path'), { code: 'EINVAL' });
    return this.prefix(vault) + crypto.createHash('sha256').update(filePath).digest('hex') + '.draft';
  }

  async inventory() {
    const items = [];
    for (const name of await fs.readdir(this.config.draftDir)) {
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.draft$/.test(name)) continue;
      const stat = await fs.stat(path.join(this.config.draftDir, name));
      if (Date.now() - stat.mtimeMs >= this.config.draftTtlMs) await fs.unlink(path.join(this.config.draftDir, name));
      else items.push({ name, size: stat.size });
    }
    return items;
  }

  decode(key, name, data) {
    const packed = JSON.parse(data);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(packed.iv, 'base64'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(packed.data, 'base64')), decipher.final()]).toString('utf8'));
  }

  list(vault) {
    const prefix = this.prefix(vault);
    return this.exclusive(async key => {
      const result = [];
      for (const item of (await this.inventory()).filter(item => item.name.startsWith(prefix))) {
        result.push(this.decode(key, item.name, await fs.readFile(path.join(this.config.draftDir, item.name), 'utf8')));
      }
      return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  prune() { return this.exclusive(() => this.inventory()); }

  put(vault, payload) {
    if (!payload || typeof payload.content !== 'string' || payload.content.includes('\0') || !/^[a-f0-9]{64}$/.test(payload.baseVersion || '')) {
      throw Object.assign(new Error('Invalid draft'), { code: 'EINVAL' });
    }
    if (Buffer.byteLength(payload.content) > this.config.maxFileBytes) throw Object.assign(new Error('Draft exceeds editor size limit'), { code: 'EFBIG' });
    const name = this.filename(vault, payload.path);
    const prefix = this.prefix(vault);
    return this.exclusive(async key => {
      const now = Date.now();
      const draft = { path: normalizeDirectoryPath(payload.path), content: payload.content, baseVersion: payload.baseVersion,
        updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.config.draftTtlMs).toISOString() };
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(name));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(draft)), cipher.final()]);
      const data = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
      const items = (await this.inventory()).filter(item => item.name !== name);
      const owned = items.filter(item => item.name.startsWith(prefix));
      if (owned.length >= 20 || owned.reduce((sum, item) => sum + item.size, 0) + Buffer.byteLength(data) > 16 * 1024 * 1024 ||
        items.length >= 512 || items.reduce((sum, item) => sum + item.size, 0) + Buffer.byteLength(data) > 64 * 1024 * 1024) {
        throw Object.assign(new Error('Draft storage is full; remove an old draft first'), { statusCode: 429 });
      }
      const temporary = path.join(this.config.draftDir, '.' + crypto.randomUUID() + '.tmp');
      try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, path.join(this.config.draftDir, name));
      } finally { await fs.unlink(temporary).catch(() => {}); }
      return { path: draft.path, updatedAt: draft.updatedAt, expiresAt: draft.expiresAt };
    });
  }

  remove(vault, value) {
    const prefix = this.prefix(vault);
    const name = value ? this.filename(vault, value) : null;
    return this.exclusive(async () => {
      const items = await this.inventory();
      for (const item of items.filter(item => name ? item.name === name : item.name.startsWith(prefix))) await fs.unlink(path.join(this.config.draftDir, item.name));
    });
  }
}

module.exports = { DraftStore };
