'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, baseURL, token, outputFolder, browserOptions } = require('./browser-test-support.cjs');

async function main() {
  await fs.mkdir(outputFolder, { recursive: true });
  const browser = await chromium.launch(browserOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); const errors = []; const created = new Set();
  const fixture = `/tmp/ws-terminal-workflows-${Date.now()}`; const file = `${fixture}/note.conf`;
  await page.addInitScript(() => {
    const Native = window.WebSocket; window.qaInputs = [];
    window.WebSocket = class extends Native {
      send(raw) { const message = JSON.parse(raw); if (message.type === 'input') window.qaInputs.push(message.data); return super.send(raw); }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  async function json(endpoint, options = {}) {
    const response = await context.request.fetch(baseURL + endpoint, options); const body = await response.json();
    assert.ok(response.ok(), `${endpoint}: HTTP ${response.status()} ${JSON.stringify(body)}`); return body;
  }
  const mutate = (operation, target, name) => json('/api/filesystem/mutate', { method: 'POST', data: { operation, path: target, name } });
  const read = () => json('/api/filesystem/read', { method: 'POST', data: { path: file } });
  const write = async content => { const current = await read(); return json('/api/filesystem/write', { method: 'POST', data: { path: file, content, expectedVersion: current.version } }); };
  const editor = () => page.locator('.file-pane.active > .file-editor .cm-content');
  const navigate = async () => {
    await page.getByLabel('目录路径', { exact: true }).fill(fixture);
    await page.getByRole('button', { name: '跳转目录', exact: true }).click();
    await page.getByRole('treeitem', { name: 'note.conf', exact: true }).waitFor();
  };
  const paste = text => page.evaluate(text => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  try {
    await page.goto(baseURL);
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill(token);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/');
    await page.waitForFunction(() => document.querySelector('#nodeIdentity')?.textContent.includes('root'));
    await mutate('create-directory', '/tmp', path.posix.basename(fixture));
    await mutate('create-file', fixture, 'note.conf'); created.add(file); await write('note=original\n');

    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#meta').textContent.includes('/bin/bash'));
    const original = (await json('/api/terminals')).sessions[0];
    await page.reload(); await page.waitForFunction(() => document.querySelector('#nodeIdentity').textContent.includes('root'));
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await page.getByRole('button', { name: '终端会话', exact: true }).click();
    await page.getByRole('button', { name: '恢复终端', exact: true }).waitFor();
    assert.ok((await page.locator('.utility-row').textContent()).includes('剩余'));
    await page.getByRole('button', { name: '恢复终端', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#meta').textContent.includes('/bin/bash'));
    const restored = (await json('/api/terminals')).sessions[0]; assert.equal(restored.id, original.id); assert.equal(restored.pid, original.pid);
    assert.equal(await page.getByRole('button', { name: '断开', exact: true }).count(), 0);

    const command = `touch ${fixture}/paste-proof\nprintf 'WF_%s\\n' 'PASTED'\n`;
    await paste(command); await page.getByRole('button', { name: '确认粘贴', exact: true }).waitFor();
    assert.equal((await context.request.get(`${baseURL}/api/filesystem/stat?path=${encodeURIComponent(fixture + '/paste-proof')}`)).status(), 404);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await context.request.get(`${baseURL}/api/filesystem/stat?path=${encodeURIComponent(fixture + '/paste-proof')}`)).status(), 404);
    await paste(command); await page.getByRole('button', { name: '确认粘贴', exact: true }).click();
    await page.waitForFunction(() => window.qaInputs.some(value => value.includes('paste-proof')), { timeout: 5000 });
    await page.locator('.xterm-helper-textarea').press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen').textContent.includes('WF_PASTED'));
    created.add(fixture + '/paste-proof');
    await page.getByRole('button', { name: '结束终端', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.terminal-pane'));
    assert.equal((await json('/api/terminals')).sessions.length, 0);

    await navigate(); await page.getByRole('treeitem', { name: 'note.conf', exact: true }).click(); await editor().waitFor();
    await page.getByRole('button', { name: '短期草稿', exact: true }).click();
    await page.getByRole('checkbox', { name: '加密草稿自动备份' }).check();
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    const secret = `draft-secret-${Date.now()}`; await editor().fill(secret);
    await page.waitForFunction(() => document.querySelector('.file-message').textContent.includes('加密草稿已备份'));
    assert.equal(await page.evaluate(secret => Object.values(localStorage).some(value => value.includes(secret)), secret), false);
    await page.reload(); await page.getByRole('button', { name: '恢复草稿', exact: true }).waitFor();
    assert.equal((await editor().textContent()).includes(secret), false);
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click(); assert.ok((await editor().textContent()).includes(secret));
    await page.getByRole('button', { name: '关闭 note.conf', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click(); assert.ok((await editor().textContent()).includes(secret));
    await page.getByRole('button', { name: '关闭 note.conf', exact: true }).click();
    await page.getByRole('button', { name: '保存并关闭', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.file-pane')); assert.equal((await read()).content, secret + '\n');

    await navigate(); await page.getByRole('treeitem', { name: 'note.conf', exact: true }).click(); await editor().waitFor();
    await editor().fill('discard-this'); await page.getByRole('button', { name: '关闭 note.conf', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.file-pane')); assert.equal((await read()).content, secret + '\n');
    await page.getByRole('treeitem', { name: 'note.conf', exact: true }).click(); await editor().waitFor();
    await editor().fill('local-change'); await write('disk-change\n'); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.file-message').textContent.includes('磁盘内容已更新'));
    await page.getByRole('button', { name: '比较并合并', exact: true }).click();
    await page.locator('.merge-workspace .cm-content').last().fill('disk-change\nlocal-change');
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.1-merge-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.1-merge-mobile.png') });
    assert.ok((await page.locator('#utilityDialog').boundingBox()).width < 390);
    await page.getByRole('button', { name: '采用合并结果', exact: true }).click(); await page.setViewportSize({ width: 1440, height: 900 });
    await editor().press('Control+s'); await page.waitForFunction(() => document.querySelector('.file-message').textContent === '已保存');
    assert.equal((await read()).content, 'disk-change\nlocal-change\n');

    await page.route('**/api/filesystem/write', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Permission denied' }) }));
    await editor().fill('keep-after-error'); await editor().press('Control+s');
    await page.waitForFunction(() => document.querySelector('.file-message').textContent.includes('访问被拒绝'));
    assert.ok(await editor().isVisible()); assert.ok((await editor().textContent()).includes('keep-after-error'));
    assert.ok((await page.locator('#statusDot').getAttribute('class')).includes('ready'));
    await page.unroute('**/api/filesystem/write'); await editor().press('Control+s');
    await page.waitForFunction(() => document.querySelector('.file-message').textContent === '已保存');
    await page.route('**/api/filesystem/read', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Bad Gateway' }) }));
    await page.getByRole('button', { name: '重新读取文件', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.file-message').textContent.includes('反向代理'));
    assert.ok(await editor().isVisible()); assert.ok((await page.locator('#statusDot').getAttribute('class')).includes('ready'));
    await page.unroute('**/api/filesystem/read'); await page.getByRole('button', { name: '重新读取文件', exact: true }).click();
    await editor().waitFor();

    await page.route('**/api/filesystem/write', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) }));
    await editor().fill('keep-through-login'); await editor().press('Control+s');
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).waitFor();
    assert.ok((await editor().textContent()).includes('keep-through-login'));
    await page.unroute('**/api/filesystem/write');
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill(token);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#authDialog')?.open && !document.querySelector('#tokenInput'));
    assert.ok((await editor().textContent()).includes('keep-through-login'));
    await editor().press('Control+s'); await page.waitForFunction(() => document.querySelector('.file-message').textContent === '已保存');

    await navigate();
    await page.getByRole('button', { name: '新建文件', exact: true }).click();
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('.env');
    await page.getByRole('button', { name: '确认', exact: true }).click(); created.add(fixture + '/.env');
    await page.getByRole('button', { name: '显示隐藏文件', exact: true }).click();
    await page.getByRole('treeitem', { name: '.env', exact: true }).waitFor();
    for (let start = 0; start < 520; start += 4) await Promise.all(Array.from({ length: Math.min(4, 520 - start) }, async (_, offset) => {
      const name = `item-${String(start + offset).padStart(4, '0')}`; await mutate('create-file', fixture, name); created.add(fixture + '/' + name);
    }));
    await page.getByRole('button', { name: '刷新目录', exact: true }).click();
    await page.getByRole('button', { name: /加载更多/ }).click();
    await page.getByRole('treeitem', { name: 'item-0519', exact: true }).waitFor();
    await page.getByRole('combobox', { name: '目录搜索范围', exact: true }).selectOption('remote');
    await page.getByRole('searchbox', { name: '筛选目录条目', exact: true }).fill('item-0519');
    await page.waitForFunction(() => document.querySelector('#treeSummary').textContent.includes('1 / 1'));
    await page.getByRole('treeitem', { name: 'item-0519', exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.1-search.png') });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Workflow acceptance passed: manual PTY recovery, precise end semantics, multiline paste confirmation/cancel, encrypted draft recovery, save/discard/cancel close, manual merge, local error states, hidden creation, pagination and full-directory search.');
  } catch (error) {
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.1-failure.png') }).catch(() => {});
    console.error('Page errors:', errors);
    console.error('Test input count:', await page.evaluate(() => window.qaInputs?.length)); throw error;
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    const vault = await page.evaluate(() => localStorage.getItem('ws-terminal-draft-vault')).catch(() => null);
    if (vault) await context.request.delete(baseURL + '/api/drafts', { headers: { 'X-Draft-Vault': vault } }).catch(() => {});
    for (const session of (await json('/api/terminals').catch(() => ({ sessions: [] }))).sessions) await json(`/api/terminals?id=${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {});
    for (const value of created) await mutate('delete', value).catch(() => {});
    await mutate('delete', fixture).catch(() => {});
    await context.request.post(baseURL + '/api/logout').catch(() => {}); await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
