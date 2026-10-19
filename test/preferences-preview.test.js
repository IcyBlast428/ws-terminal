'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { FileService, previewType } = require('../server/src/file-service');
const { normalize, defaults } = require('../public/assets/preferences');
const { createStaticHandler, applySecurityHeaders } = require('../server/src/static');

test('preferences whitelist values, bound numbers and never retain unrelated data', () => {
  assert.deepEqual(normalize(null), defaults);
  const value = normalize({ theme: 'light', wordWrap: true, indentSize: 999, useTabs: 'true', keymap: 'vim', language: 'json', terminalFontSize: 0, scrollback: -1, token: 'secret', arbitrary: 'value' });
  assert.equal(value.theme, 'light'); assert.equal(value.indentSize, 8); assert.equal(value.useTabs, false); assert.equal(value.terminalFontSize, 10); assert.equal(value.scrollback, 1000);
  assert.equal(value.token, undefined); assert.equal(value.arbitrary, undefined); assert.equal(normalize({ theme: 'url(x)', language: '__proto__' }).language, 'auto');
});

test('preview detects supported bytes and rejects executable SVG or HTML even with misleading names', () => {
  assert.equal(previewType(Buffer.from('%PDF-1.4\n')), 'application/pdf');
  assert.equal(previewType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
  assert.equal(previewType(Buffer.from('<svg onload="alert(1)">')), null);
  assert.equal(previewType(Buffer.from('<html><script>')), null);
  assert.equal(previewType(Buffer.from([])), null);
});

test('binary preview is byte-exact, attachment-only, size bounded and closes file handles', { skip: process.platform !== 'linux' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-terminal-preview-'));
  const service = new FileService({ maxTransferBytes: 1000, maxPreviewBytes: 100 });
  const file = path.join(directory, 'note.pdf'); const content = Buffer.from('%PDF-1.4\nfixture');
  try {
    await fs.writeFile(file, content);
    const response = new PassThrough(); const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.writeHead = (status, headers) => { assert.equal(status, 200); assert.equal(headers['Content-Type'], 'application/pdf'); assert.ok(headers['Content-Disposition'].startsWith('attachment;')); };
    await service.preview(file, { method: 'GET' }, response); assert.deepEqual(Buffer.concat(chunks), content);
    await fs.writeFile(file, '%PDF-' + 'x'.repeat(100)); await assert.rejects(service.preview(file, { method: 'GET' }, new PassThrough()), { code: 'EFBIG' });
    await fs.writeFile(file, '<svg/>'); await assert.rejects(service.preview(file, { method: 'GET' }, new PassThrough()), { code: 'EISBINARY' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('unauthenticated workbench redirects to a real login page, authenticated login returns to workbench', () => {
  const handler = createStaticHandler({ rootDir: path.resolve(__dirname, '..'), auth: { required: true } }, {}, { verifyRequest: req => req.authenticated });
  const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} });
  const anonymous = response(); handler({ method: 'GET' }, anonymous, new URL('http://localhost/'));
  assert.equal(anonymous.status, 303); assert.equal(anonymous.headers.Location, '/login');
  const loggedIn = response(); handler({ method: 'GET', authenticated: true }, loggedIn, new URL('http://localhost/login'));
  assert.equal(loggedIn.status, 303); assert.equal(loggedIn.headers.Location, '/');
  const security = response(); applySecurityHeaders(security); assert.ok(security.headers['Content-Security-Policy'].includes("object-src 'none'")); assert.ok(!security.headers['Content-Security-Policy'].includes("'unsafe-eval'"));
});
