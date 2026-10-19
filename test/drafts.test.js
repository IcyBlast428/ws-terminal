'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DraftStore } = require('../server/src/draft-store');
const { errorText, needsPasteApproval, pastePreview } = require('../public/assets/workbench-model');
const vault = 'a'.repeat(64);

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-terminal-drafts-'));
  const config = { draftDir: directory, draftTtlMs: 60000, maxFileBytes: 1024 };
  try { await run(new DraftStore(config), config); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('encrypts drafts, isolates vaults, survives store restart, and preserves original bytes', () => fixture(async (store, config) => {
  const payload = { path: '/etc/example.conf', content: '\uFEFFsecret-content\r\n\r\n', baseVersion: 'b'.repeat(64) };
  await store.put(vault, payload);
  assert.equal((await store.list(vault))[0].content, payload.content);
  assert.deepEqual(await store.list('c'.repeat(64)), []);
  const name = (await fs.readdir(config.draftDir)).find(name => name.endsWith('.draft'));
  const bytes = await fs.readFile(path.join(config.draftDir, name));
  assert.equal(bytes.includes('secret-content'), false); assert.equal(bytes.includes('/etc/example.conf'), false);
  if (process.platform === 'linux') assert.equal((await fs.stat(path.join(config.draftDir, name))).mode & 0o777, 0o600);
  assert.equal((await new DraftStore(config).list(vault))[0].content, payload.content);
  await store.remove(vault, payload.path); assert.deepEqual(await store.list(vault), []);
}));

test('expires drafts, detects tampering, validates input, and bounds vault storage', () => fixture(async (store, config) => {
  assert.throws(() => store.list('../escape'), { code: 'EINVAL' });
  assert.throws(() => store.put(vault, null), { code: 'EINVAL' });
  assert.throws(() => store.put(vault, { path: '/a', content: 'x'.repeat(1025), baseVersion: 'b'.repeat(64) }), { code: 'EFBIG' });
  for (let index = 0; index < 20; index++) await store.put(vault, { path: `/file-${index}`, content: 'ok', baseVersion: 'b'.repeat(64) });
  await assert.rejects(store.put(vault, { path: '/overflow', content: 'ok', baseVersion: 'b'.repeat(64) }), { statusCode: 429 });
  const name = store.filename(vault, '/file-0');
  await fs.utimes(path.join(config.draftDir, name), new Date(0), new Date(0));
  assert.equal((await store.list(vault)).length, 19);
  await store.put(vault, { path: '/new', content: 'ok', baseVersion: 'b'.repeat(64) });
  const target = store.filename(vault, '/new');
  const record = JSON.parse(await fs.readFile(path.join(config.draftDir, target), 'utf8'));
  record.tag = Buffer.alloc(16).toString('base64'); await fs.writeFile(path.join(config.draftDir, target), JSON.stringify(record));
  await assert.rejects(store.list(vault));
}));

test('previews multiline and control-character pastes and classifies local errors', () => {
  assert.equal(needsPasteApproval('ls -al'), false);
  for (const value of ['ls\n', 'a\r\nb', '\x1b[31m', 'x\x03']) assert.equal(needsPasteApproval(value), true);
  assert.equal(pastePreview('\x1b[31m'), '\\x1b[31m');
  assert.match(errorText({ status: 401, message: 'Unauthorized' }), /登录已过期/);
  assert.match(errorText({ status: 403, message: 'Permission denied' }), /访问被拒绝/);
  assert.match(errorText({ status: 502, message: 'Bad Gateway' }), /反向代理/);
  assert.match(errorText({ kind: 'network' }), /网络连接失败/);
});
