'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, baseURL, token, outputFolder, browserOptions } = require('./browser-test-support.cjs');

function samplePdf() {
  const streams = ['1 0 0 rg 30 30 160 90 re f BT /F1 18 Tf 30 150 Td (FIRST PAGE) Tj ET', '0 0 1 rg 30 30 160 90 re f BT /F1 18 Tf 30 150 Td (SECOND PAGE) Tj ET'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>', `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>', `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function main() {
  await fs.mkdir(outputFolder, { recursive: true });
  const browser = await chromium.launch(browserOptions); const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage();
  const fixture = `/tmp/ws-terminal-previews-${Date.now()}`; const errors = []; const external = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL).origin) external.push(request.url()); });
  const json = async (endpoint, options = {}) => { const response = await context.request.fetch(baseURL + endpoint, options); const data = await response.json(); assert.ok(response.ok(), `${endpoint}: ${response.status()} ${JSON.stringify(data)}`); return data; };
  const mutate = (operation, target, name) => json('/api/filesystem/mutate', { method: 'POST', data: { operation, path: target, name } });
  const read = target => json('/api/filesystem/read', { method: 'POST', data: { path: target } });
  const upload = (name, data) => json(`/api/filesystem/upload?path=${encodeURIComponent(fixture + '/' + name)}`, { method: 'POST', data, headers: { 'Content-Type': 'application/octet-stream' } });
  const editor = () => page.locator('.file-pane.active > .file-editor .cm-content');
  const close = () => page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  const open = async name => { await page.locator(`.tree-row[data-path="${fixture}/${name}"] .tree-main`).click(); };
  const settings = async category => { await page.getByRole('button', { name: '设置', exact: true }).click(); if (category) await page.getByRole('tab', { name: category, exact: true }).click(); };
  async function cleanup() {
    const listing = await json(`/api/filesystem/list?hidden=1&path=${encodeURIComponent(fixture)}`);
    for (const entry of listing.entries) await mutate('delete', entry.path);
    await mutate('delete', fixture);
  }
  try {
    await page.goto(baseURL); await page.waitForURL(url => url.pathname === '/login');
    assert.equal(await page.locator('#layoutRoot').count(), 0); await page.screenshot({ path: path.join(outputFolder, 'workbench-1.3-login-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(outputFolder, 'workbench-1.3-login-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill('invalid-test-token'); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '访问令牌不正确' }).waitFor(); assert.equal(await page.locator('#tokenInput').inputValue(), '');
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill(token); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/'); await page.waitForFunction(() => document.querySelector('#nodeIdentity')?.textContent.includes('root'));
    assert.equal(await page.locator('#tokenInput').count(), 0); assert.equal(await page.locator('.terminal-pane').count(), 0);
    assert.equal(await page.evaluate(token => Object.values(localStorage).some(value => value.includes(token)), token), false);
    await mutate('create-directory', '/tmp', path.posix.basename(fixture));
    const texts = { 'note.txt': 'first\nsecond\n', 'data.json': '{"message":"<img src=x onerror=alert(1)>","nested":{"enabled":true,"items":[1,2]}}\n', 'table.csv': 'name,description\r\nAlice,"one,two"\r\nBob,"multi\nline"\r\n', 'readme.md': '# Preview heading\n\n**Bold text**\n\n![local](sample.png)\n\n<script>parent.qaAttack=true</script><img src="https://blocked.invalid/leak" onerror="parent.qaAttack=true"><svg onload="parent.qaAttack=true"></svg>\n', 'evil.png': '<svg onload="parent.qaAttack=true"></svg>' };
    for (const [name, content] of Object.entries(texts)) await upload(name, Buffer.from(content));
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; const context = canvas.getContext('2d'); context.fillStyle = '#e34853'; context.fillRect(0, 0, 80, 90); context.fillStyle = '#29996b'; context.fillRect(80, 0, 80, 90); return canvas.toDataURL('image/png').split(',')[1]; });
    await upload('sample.png', Buffer.from(png, 'base64')); await upload('sample.pdf', samplePdf());
    assert.equal((await context.request.get(`${baseURL}/api/filesystem/preview?path=${encodeURIComponent(fixture + '/evil.png')}`)).status(), 415);
    const anonymous = await browser.newContext(); assert.equal((await anonymous.request.get(`${baseURL}/api/filesystem/preview?path=${encodeURIComponent(fixture + '/sample.pdf')}`)).status(), 401); await anonymous.close();
    assert.equal((await context.request.get(`${baseURL}/api/filesystem/preview?path=${encodeURIComponent(fixture + '/sample.pdf')}`, { headers: { Origin: 'https://untrusted.invalid' } })).status(), 403);
    await page.locator('#pathInput').fill(fixture); await page.getByRole('button', { name: '跳转目录', exact: true }).click();
    await open('note.txt'); await editor().waitFor();
    await settings('外观'); await page.getByLabel('主题', { exact: true }).selectOption('light'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('.file-explorer').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    await page.getByRole('tab', { name: '编辑器', exact: true }).click(); await page.getByLabel('编辑器字号', { exact: true }).fill('17'); await page.getByLabel('编辑器字号', { exact: true }).press('Tab');
    await page.getByLabel('自动换行', { exact: true }).check(); await page.getByLabel('缩进宽度', { exact: true }).fill('4'); await page.getByLabel('缩进宽度', { exact: true }).press('Tab'); await close();
    assert.equal(await page.locator('.file-pane.active .file-editor').evaluate(element => element.style.fontSize), '17px'); assert.ok(await page.locator('.file-pane.active .cm-lineWrapping').count());
    await editor().fill(''); await editor().press('Tab'); await editor().press('x'); assert.equal((await editor().textContent()), '    x');
    assert.ok((await page.locator('.file-pane.active .cursor-position').textContent()).includes('Col 6'));
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.file-pane.active .file-message')?.textContent === '已保存');
    await settings('编辑器'); await page.getByLabel('使用 Tab 缩进', { exact: true }).check(); await page.getByLabel('编辑器键位', { exact: true }).selectOption('vim'); await close();
    await editor().click(); await editor().press('Home'); await editor().press('i'); await editor().press('v'); await editor().press('Escape'); assert.ok((await editor().textContent()).includes('v'));
    await editor().press(':'); await page.keyboard.type('w'); await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelector('.file-pane.active .file-message')?.textContent === '已保存'); assert.ok((await read(fixture + '/note.txt')).content.includes('v'));
    await settings('编辑器'); await page.getByLabel('编辑器键位', { exact: true }).selectOption('emacs'); await close(); await editor().click(); await editor().press('Control+s'); await page.locator('.cm-search').waitFor(); await editor().press('Escape');
    await settings('编辑器'); await page.getByLabel('编辑器键位', { exact: true }).selectOption('default'); await close(); await editor().fill(''); await editor().press('Tab'); await editor().press('t'); assert.equal(await editor().textContent(), '\tt');
    await page.getByRole('combobox', { name: '文件语言', exact: true }).selectOption('json'); assert.ok((await page.locator('.cursor-position').first().textContent()).includes('JSON'));
    await page.getByRole('button', { name: '保存', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.file-pane.active .file-message')?.textContent === '已保存');
    await page.reload(); await page.waitForFunction(() => document.querySelector('#nodeIdentity')?.textContent.includes('root')); assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('.terminal-pane').count(), 0); await page.locator('#pathInput').fill(fixture); await page.getByRole('button', { name: '跳转目录', exact: true }).click();
    await open('data.json'); await editor().waitFor(); await page.getByRole('combobox', { name: '打开方式', exact: true }).selectOption('json'); await page.locator('.file-pane.active .json-value').first().waitFor();
    assert.ok((await page.locator('.json-preview').textContent()).includes('<img src=x')); assert.equal(await page.locator('.json-preview img').count(), 0);
    await open('table.csv'); await editor().waitFor(); await page.getByRole('combobox', { name: '打开方式', exact: true }).selectOption('csv'); await page.getByRole('table', { name: 'CSV 表格', exact: true }).waitFor();
    assert.equal(await page.locator('.csv-preview tbody tr').count(), 2); assert.ok((await page.locator('.csv-preview').textContent()).includes('one,two')); assert.ok((await page.locator('.csv-preview').textContent()).includes('multi\nline'));
    await open('readme.md'); await editor().waitFor(); await page.getByRole('combobox', { name: '打开方式', exact: true }).selectOption('markdown');
    const frame = page.frameLocator('iframe.markdown-preview'); await frame.getByRole('heading', { name: 'Preview heading', exact: true }).waitFor();
    assert.equal(await page.locator('iframe.markdown-preview').getAttribute('sandbox'), ''); assert.equal(await frame.locator('script, svg, iframe').count(), 0); assert.equal(await page.evaluate(() => window.qaAttack), undefined);
    await page.waitForFunction(() => true); assert.deepEqual(external, []);
    await frame.getByRole('img', { name: 'local', exact: true }).waitFor(); assert.equal(await frame.getByRole('img', { name: 'local', exact: true }).evaluate(async image => { await image.decode(); return image.naturalWidth; }), 160);
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.3-markdown.png') });
    await page.getByRole('combobox', { name: '打开方式', exact: true }).selectOption('text'); assert.ok((await editor().textContent()).includes('parent.qaAttack')); assert.equal((await read(fixture + '/readme.md')).content, texts['readme.md']);
    await open('sample.png'); await page.waitForFunction(() => document.querySelector('.file-pane.active .image-preview img')?.naturalWidth === 160);
    await page.getByRole('button', { name: '放大图片', exact: true }).click(); assert.ok((await page.locator('.image-preview').evaluate(element => element.previousElementSibling.textContent)).includes('125%'));
    await page.getByRole('button', { name: '旋转图片', exact: true }).click(); assert.ok((await page.locator('.image-preview img').getAttribute('style')).includes('90deg'));
    await open('sample.pdf');
    const color = async channel => page.waitForFunction(channel => { const canvas = document.querySelector('.file-pane.active .pdf-preview canvas'); if (!canvas?.width) return false; const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let pixels = 0; for (let index = 0; index < bytes.length; index += 4) if (bytes[index + channel] > 180 && bytes[index + (channel === 0 ? 2 : 0)] < 70) pixels++; return pixels > 100; }, channel);
    await color(0); assert.equal(await page.getByRole('spinbutton', { name: 'PDF 页码', exact: true }).getAttribute('max'), '2'); await page.getByRole('button', { name: 'PDF 下一页', exact: true }).click(); await color(2);
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.3-pdf-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await settings('编辑器'); await page.screenshot({ path: path.join(outputFolder, 'workbench-1.3-settings-mobile.png') }); assert.ok((await page.locator('#utilityDialog').boundingBox()).width < 390); await close();
    await page.route('**/api/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })); await page.getByRole('button', { name: '退出', exact: true }).click(); await page.locator('.notification').filter({ hasText: '未能确认退出' }).waitFor(); assert.equal(new URL(page.url()).pathname, '/'); assert.ok(await page.locator('.file-pane').count()); await page.unroute('**/api/logout');
    await page.getByRole('button', { name: '退出', exact: true }).click(); await page.waitForURL(url => url.pathname === '/login'); assert.equal(await page.locator('#layoutRoot').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ ok: true, checks: ['dedicated-login-and-logout', 'no-token-storage-or-auto-terminal', 'settings-persist', 'wrap-indent-and-language', 'vim-and-emacs', 'json-tree-xss', 'csv-quoted-records', 'sandboxed-markdown-local-images', 'image-controls', 'pdf-real-pixels-and-pagination', 'preview-auth-and-content-validation', 'desktop-mobile'], errors, externalRequests: external.length }));
  } finally {
    await context.request.post(baseURL + '/api/login', { data: { token } }).catch(() => {}); await cleanup().catch(() => {}); await context.request.post(baseURL + '/api/logout').catch(() => {}); await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
