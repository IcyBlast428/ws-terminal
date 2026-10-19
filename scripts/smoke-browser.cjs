'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, baseURL, token, outputFolder, browserOptions } = require('./browser-test-support.cjs');
const fixture = `/tmp/ws-terminal-browser-${Date.now()}`;
const file = `${fixture}/note.conf`;

async function run() {
  await fs.mkdir(outputFolder, { recursive: true });
  const browser = await chromium.launch(browserOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage(); const errors = [];
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.qaSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); window.qaSockets.push(this); }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  async function json(endpoint, options = {}) {
    const response = await context.request.fetch(`${baseURL}${endpoint}`, options);
    const payload = await response.json();
    assert.ok(response.ok(), `${endpoint}: ${response.status()} ${JSON.stringify(payload)}`); return payload;
  }
  const read = () => json('/api/filesystem/read', { method: 'POST', data: { path: file } });
  const mutate = (operation, target, name) => json('/api/filesystem/mutate', { method: 'POST', data: { operation, path: target, name } });
  try {
    await page.goto(baseURL); await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill(token);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#nodeIdentity').textContent.includes('root'));
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await mutate('create-directory', '/tmp', path.posix.basename(fixture));
    const original = '\uFEFFalpha=1\r\n\r\n';
    const upload = await context.request.post(`${baseURL}/api/filesystem/upload?path=${encodeURIComponent(file)}`, { data: Buffer.from(original), headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(upload.status(), 200);
    await page.getByLabel('目录路径', { exact: true }).fill(fixture);
    await page.getByRole('button', { name: '跳转目录', exact: true }).click();
    await page.getByRole('treeitem', { name: 'note.conf', exact: true }).click();
    const explorerBounds = await page.locator('#fileExplorer').boundingBox();
    for (const size of await page.locator('.tree-size').all()) {
      const bounds = await size.boundingBox();
      assert.ok(bounds.x >= explorerBounds.x && bounds.x + bounds.width <= explorerBounds.x + explorerBounds.width);
    }
    const editor = page.locator('.cm-content'); await editor.waitFor();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('alpha=1'));
    assert.equal(await page.locator('.cm-line').count(), 2);
    await editor.fill('alpha=2\n'); await editor.press('Control+s');
    await page.waitForFunction(() => document.querySelector('.file-message')?.textContent === '已保存');
    assert.equal((await read()).content, '\uFEFFalpha=2\r\n\r\n');
    await page.getByRole('button', { name: '历史版本', exact: true }).click();
    await page.locator('.utility-row').first().waitFor();
    assert.equal(await page.locator('.utility-row').count(), 1);
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#utilityDialog').open);
    assert.equal((await read()).content, original);
    await editor.fill('alpha=3\n');
    await page.getByRole('button', { name: '对比修改', exact: true }).click();
    assert.ok((await page.locator('.diff-output').textContent()).includes('alpha=3'));
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    const current = await read();
    await json('/api/filesystem/write', { method: 'POST', data: { path: file, content: 'alpha=4\n', expectedVersion: current.version } });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.file-message')?.textContent.includes('磁盘内容已更新'));
    assert.ok((await editor.textContent()).includes('alpha=3'));
    await page.getByRole('button', { name: '重新读取文件', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('alpha=4'));

    const uploadName = 'uploaded.txt'; await page.locator('#uploadInput').setInputFiles({ name: uploadName, mimeType: 'text/plain', buffer: Buffer.from('browser upload\n') });
    await page.waitForFunction(() => document.querySelector('#transferStatus').textContent.includes('上传完成'));
    const largeUpload = Buffer.alloc(100000, 65);
    await page.locator('#uploadInput').setInputFiles({ name: uploadName, mimeType: 'text/plain', buffer: largeUpload });
    await page.getByRole('button', { name: '覆盖', exact: true }).waitFor();
    await page.getByRole('button', { name: '覆盖', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#transferStatus button') && document.querySelector('#transferStatus').textContent.includes('上传完成'));
    assert.equal((await json(`/api/filesystem/stat?path=${encodeURIComponent(fixture + '/' + uploadName)}`)).size, largeUpload.length);
    assert.equal((await json(`/api/filesystem/history?path=${encodeURIComponent(fixture + '/' + uploadName)}`)).items.length, 1);
    await context.request.post(`${baseURL}/api/filesystem/upload?path=${encodeURIComponent(fixture + '/.hidden')}`, { data: Buffer.from('hidden'), headers: { 'Content-Type': 'application/octet-stream' } });
    await page.getByRole('button', { name: '刷新目录', exact: true }).click();
    assert.equal(await page.getByRole('treeitem', { name: '.hidden', exact: true }).count(), 0);
    await page.getByRole('button', { name: '显示隐藏文件', exact: true }).click();
    await page.getByRole('treeitem', { name: '.hidden', exact: true }).waitFor();
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '下载文件', exact: true }).click();
    const download = await downloadPromise; assert.equal(download.suggestedFilename(), 'note.conf');
    const savedDownload = path.join(outputFolder, 'download-check.conf'); await download.saveAs(savedDownload);
    assert.equal(await fs.readFile(savedDownload, 'utf8'), 'alpha=4\n');

    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#meta').textContent.includes('/bin/bash'));
    let sessions = (await json('/api/terminals')).sessions; assert.equal(sessions.length, 1); const session = sessions[0];
    await page.locator('.xterm-helper-textarea').fill('');
    await page.locator('.xterm-helper-textarea').pressSequentially('printf "BROWSER_%s\\n" "BEFORE"'); await page.locator('.xterm-helper-textarea').press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen').textContent.includes('BROWSER_BEFORE'));
    await context.setOffline(true);
    await page.evaluate(() => window.qaSockets.at(-1).close(1000, 'transient network QA'));
    await page.waitForTimeout(100);
    sessions = (await json('/api/terminals')).sessions;
    assert.equal(sessions[0].attached, false);
    await page.waitForTimeout(600); await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector('#meta').textContent.includes('/bin/bash'), { timeout: 20000 });
    sessions = (await json('/api/terminals')).sessions; assert.equal(sessions[0].id, session.id); assert.equal(sessions[0].pid, session.pid);
    await page.getByRole('button', { name: '关闭 Terminal 1', exact: true }).click();
    for (let attempt = 0; attempt < 20 && (await json('/api/terminals')).sessions.length; attempt++) await page.waitForTimeout(100);
    assert.equal((await json('/api/terminals')).sessions.length, 0);

    await page.getByRole('button', { name: '隐藏目录', exact: true }).click();
    assert.equal(await page.locator('#fileExplorer').isVisible(), false);
    await page.getByRole('button', { name: '显示目录', exact: true }).click();
    const resizer = page.locator('#explorerResizer'); await resizer.press('ArrowRight'); await resizer.press('ArrowRight');
    assert.equal(await resizer.getAttribute('aria-valuenow'), '340');
    await resizer.dblclick(); assert.equal(await resizer.getAttribute('aria-valuenow'), '300');
    await context.request.post(`${baseURL}/api/filesystem/upload?path=${encodeURIComponent(fixture + '/compare.json')}`, { data: Buffer.from('{"node":"test","enabled":true}\n'), headers: { 'Content-Type': 'application/octet-stream' } });
    await page.getByRole('button', { name: '刷新目录', exact: true }).click();
    await page.getByRole('treeitem', { name: 'compare.json', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.cm-content').length === 2);
    const tabBox = await page.getByRole('tab', { name: 'compare.json', exact: true }).boundingBox();
    const paneBox = await page.locator('.group-content').boundingBox();
    await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2); await page.mouse.down();
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height - 25, { steps: 12 });
    assert.ok(await page.locator('.drop-preview[data-side="bottom"]').isVisible()); await page.mouse.up();
    assert.equal(await page.locator('.split-group').count(), 2);
    const divider = page.locator('.split-divider'); const dividerBox = await divider.boundingBox();
    await page.mouse.move(dividerBox.x + 80, dividerBox.y + 3); await page.mouse.down();
    await page.mouse.move(dividerBox.x + 80, dividerBox.y - 100, { steps: 8 }); await page.mouse.up();
    const ratio = Number(await page.locator('.split-layout').getAttribute('data-ratio')); assert.ok(ratio < 0.5 && ratio > 0.2);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.0-desktop.png') });
    await page.reload(); await page.waitForFunction(() => [...document.querySelectorAll('.cm-content')].some(editor => editor.textContent.includes('alpha=4')));
    assert.equal(await page.locator('.split-group').count(), 2);
    assert.ok(Math.abs(Number(await page.locator('.split-layout').getAttribute('data-ratio')) - ratio) < 0.01);
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '隐藏目录', exact: true }).click();
    await page.waitForTimeout(200);
    assert.ok((await page.locator('.workbench').boundingBox()).width > 380);
    assert.ok(await page.locator('.cm-content').first().isVisible());
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.0-mobile.png') });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Browser smoke passed: editor, BOM/CRLF, backup restore, diff, external edits, upload/download, PTY reconnect/close, sidebar, workspace restore, desktop/mobile.');
  } catch (error) {
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.0-failure.png') }).catch(() => {});
    console.error('Page errors:', errors); throw error;
  } finally {
    await context.setOffline(false).catch(() => {});
    for (const session of (await json('/api/terminals').catch(() => ({ sessions: [] }))).sessions) await json(`/api/terminals?id=${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {});
    await mutate('delete', file).catch(() => {}); await mutate('delete', `${fixture}/uploaded.txt`).catch(() => {}); await mutate('delete', fixture).catch(() => {});
    await mutate('delete', `${fixture}/compare.json`).catch(() => {}); await mutate('delete', fixture).catch(() => {});
    await mutate('delete', `${fixture}/.hidden`).catch(() => {}); await mutate('delete', fixture).catch(() => {});
    await context.request.post(`${baseURL}/api/logout`).catch(() => {});
    await browser.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
