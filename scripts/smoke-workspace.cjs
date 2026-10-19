'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, baseURL, token, outputFolder, browserOptions } = require('./browser-test-support.cjs');

async function main() {
  await fs.mkdir(outputFolder, { recursive: true });
  const browser = await chromium.launch(browserOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); const errors = [];
  const fixture = `/tmp/ws-terminal-workspace-${Date.now()}`;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const json = async (endpoint, options = {}) => {
    const response = await context.request.fetch(baseURL + endpoint, options); const data = await response.json();
    assert.ok(response.ok(), `${endpoint}: ${response.status()} ${JSON.stringify(data)}`); return data;
  };
  const mutate = (operation, target, name) => json('/api/filesystem/mutate', { method: 'POST', data: { operation, path: target, name } });
  const read = target => json('/api/filesystem/read', { method: 'POST', data: { path: target } });
  const write = async (target, content) => { const current = await read(target); return json('/api/filesystem/write', { method: 'POST', data: { path: target, content, expectedVersion: current.version } }); };
  const navigate = async target => {
    await page.locator('#pathInput').fill(target); await page.getByRole('button', { name: '跳转目录', exact: true }).click();
    await page.waitForFunction(target => document.querySelector('.tree-row')?.dataset.path === target && !document.querySelector('.tree-message') && document.querySelector('#treeSummary').textContent.includes('已加载'), target);
  };
  const closeDialog = () => page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  const editor = () => page.locator('.file-pane.active > .file-editor .cm-content');
  const treeItem = target => page.locator('.tree-main').filter({ has: page.locator('.tree-name') }).and(page.locator(`[title="${target}"]`));
  const select = target => page.locator(`.tree-row[data-path="${target}"] .tree-select`);
  const confirmBatch = async label => { await page.getByRole('button', { name: `确认${label}`, exact: true }).click(); await page.locator('.operation-result').first().waitFor(); };
  const openFile = async name => { await treeItem(`${fixture}/${name}`).click(); await editor().waitFor(); await page.waitForFunction(() => !document.querySelector('.file-pane.active .file-editor').hidden && !document.querySelector('.file-pane.active .file-status')?.textContent.includes('正在读取')); };
  async function cleanup(target) {
    assert.ok(target === fixture || target.startsWith(fixture + '/'));
    const response = await context.request.get(`${baseURL}/api/filesystem/list?hidden=1&path=${encodeURIComponent(target)}`);
    if (response.ok()) for (const entry of (await response.json()).entries) {
      if (entry.type === 'directory') await cleanup(entry.path); else await mutate('delete', entry.path);
    }
    await mutate('delete', target);
  }
  try {
    for (const endpoint of ['batch', 'save-as']) assert.equal((await context.request.post(`${baseURL}/api/filesystem/${endpoint}`, { data: {} })).status(), 401);
    await page.goto(baseURL);
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill(token); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/');
    await page.waitForFunction(() => document.querySelector('#nodeIdentity')?.textContent.includes('root'));
    for (const endpoint of ['batch', 'save-as']) assert.equal((await context.request.post(`${baseURL}/api/filesystem/${endpoint}`, { headers: { Origin: 'https://untrusted.invalid' }, data: {} })).status(), 403);
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await mutate('create-directory', '/tmp', path.posix.basename(fixture));
    for (const directory of ['dest', 'moved', 'nested']) await mutate('create-directory', fixture, directory);
    for (const name of ['a.conf', 'b.txt']) { await mutate('create-file', fixture, name); await write(`${fixture}/${name}`, name === 'a.conf' ? '\uFEFFalpha\r\n\r\n' : 'bravo\n'); }
    await mutate('create-file', `${fixture}/nested`, '.hidden'); await write(`${fixture}/nested/.hidden`, 'hidden\n');
    await navigate(fixture);
    await select(`${fixture}/a.conf`).check();
    await treeItem(`${fixture}/b.txt`).click({ modifiers: ['Control'] });
    assert.equal(await page.locator('#selectionCount').textContent(), '2');
    await select(`${fixture}/b.txt`).focus(); await page.keyboard.press('Control+c');
    assert.ok((await page.locator('#clipboardStatus').textContent()).includes('待复制 2 项')); await navigate(`${fixture}/dest`);
    await page.getByRole('button', { name: '粘贴到当前目录', exact: true }).click(); await confirmBatch('复制');
    assert.equal(await page.locator('.operation-result.success').count(), 2); await closeDialog();
    assert.equal((await read(`${fixture}/dest/a.conf`)).content, '\uFEFFalpha\r\n\r\n');
    await navigate(fixture); await openFile('b.txt');
    await select(`${fixture}/b.txt`).check(); await page.getByRole('button', { name: '剪切所选', exact: true }).click();
    await navigate(`${fixture}/dest`); await page.getByRole('button', { name: '粘贴到当前目录', exact: true }).click(); await confirmBatch('移动');
    assert.ok((await page.locator('.operation-result.error').textContent()).includes('already exists')); await closeDialog();
    assert.equal((await read(`${fixture}/b.txt`)).content, 'bravo\n');
    await navigate(`${fixture}/moved`); await page.getByRole('button', { name: '粘贴到当前目录', exact: true }).click(); await confirmBatch('移动'); await closeDialog();
    assert.equal((await page.locator('.file-pane.active .file-path').textContent()), `${fixture}/moved/b.txt`);
    await editor().fill('bravo-edited'); await editor().press('Control+s');
    await page.waitForFunction(() => document.querySelector('.file-pane.active .file-message').textContent === '已保存');
    assert.equal((await read(`${fixture}/moved/b.txt`)).content, 'bravo-edited\n');
    await navigate(fixture); await select(`${fixture}/nested`).check();
    await page.getByRole('button', { name: '创建所选副本', exact: true }).click(); await confirmBatch('创建副本'); await closeDialog();
    assert.equal((await read(`${fixture}/nested copy/.hidden`)).content, 'hidden\n');
    await navigate(`${fixture}/dest`); await page.getByRole('checkbox', { name: '全选可见条目', exact: true }).check();
    assert.equal(await page.locator('#selectionCount').textContent(), '2');
    await page.getByRole('button', { name: '删除所选', exact: true }).click(); await confirmBatch('删除');
    assert.equal(await page.locator('.operation-result.success').count(), 2); await closeDialog();

    await navigate(fixture); await openFile('a.conf'); await editor().fill('saved-as');
    await editor().press('Control+Shift+s'); await page.getByLabel('新文件的完整路径', { exact: true }).fill(`${fixture}/nested/.hidden`);
    await page.getByRole('button', { name: '确认', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.input-action-form .dialog-error').textContent.length > 0);
    assert.equal((await read(`${fixture}/moved/b.txt`)).content, 'bravo-edited\n');
    await page.getByLabel('新文件的完整路径', { exact: true }).fill(`${fixture}/saved.json`); await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#utilityDialog').open);
    assert.equal((await read(`${fixture}/saved.json`)).content, '\uFEFFsaved-as\r\n');
    assert.equal((await read(`${fixture}/a.conf`)).content, '\uFEFFalpha\r\n\r\n');
    await editor().fill('local-conflict'); await write(`${fixture}/saved.json`, 'external\n');
    await page.getByRole('tab', { name: 'b.txt', exact: true }).click(); await editor().fill('batch-save');
    await page.keyboard.press('Control+Alt+s'); await page.waitForFunction(() => document.querySelectorAll('.operation-result').length === 2 && ![...document.querySelectorAll('.operation-result')].some(row => row.textContent.includes('保存中')));
    assert.equal(await page.locator('.operation-result.success').count(), 1); assert.equal(await page.locator('.operation-result.error').count(), 1); await closeDialog();
    assert.equal((await read(`${fixture}/moved/b.txt`)).content, 'batch-save\n');
    assert.equal((await read(`${fixture}/saved.json`)).content, 'external\n');
    await page.locator(`.tab-select[title="${fixture}/saved.json"]`).click(); assert.ok((await editor().textContent()).includes('local-conflict'));

    await page.keyboard.press('Control+Shift+p'); await page.getByRole('combobox', { name: '搜索命令面板', exact: true }).fill('在当前目录新建终端'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#meta').textContent.includes('/bin/bash'));
    const session = (await json('/api/terminals')).sessions[0]; assert.equal(session.cwd, fixture);
    await page.getByRole('tab', { name: 'Terminal 1', exact: true }).dblclick(); await page.getByLabel('终端名称', { exact: true }).fill('对照终端'); await page.getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('tab', { name: '对照终端', exact: true }).waitFor();
    await page.keyboard.press('Control+Alt+t'); await page.waitForFunction(() => document.querySelectorAll('.terminal-pane').length === 2);
    const dragged = page.getByRole('tab', { name: 'Terminal 2', exact: true }); const rect = await dragged.boundingBox(); const content = await page.locator('.group-content').first().boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); await page.mouse.move(content.x + content.width / 2, content.y + content.height - 18, { steps: 12 });
    await page.locator('.drop-preview[data-side="bottom"]').waitFor(); await page.mouse.up(); await page.waitForFunction(() => document.querySelectorAll('.split-group').length === 2);
    const ratio = await page.locator('.split-layout').getAttribute('data-ratio');
    await page.getByRole('button', { name: '专注当前分屏', exact: true }).last().click();
    const focused = await page.locator('.focus-target').boundingBox(); const workspace = await page.locator('#layoutRoot').boundingBox(); assert.ok(focused.height > workspace.height - 2);
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.2-focus-desktop.png') });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.focus-target').count(), 0); assert.equal(await page.locator('.split-layout').getAttribute('data-ratio'), ratio);
    await page.keyboard.press('Control+Alt+p'); await page.getByRole('combobox', { name: '搜索标签总览', exact: true }).fill('对照终端'); await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('tab', { name: '对照终端', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Control+Alt+w'); await page.getByRole('tab', { name: '对照终端', exact: true }).waitFor({ state: 'detached' });
    await page.waitForFunction(async id => !(await (await fetch('/api/terminals')).json()).sessions.some(session => session.id === id), session.id);
    await page.getByRole('button', { name: '关闭 b.txt', exact: true }).click();
    await page.getByRole('button', { name: '标签总览', exact: true }).click(); await page.getByRole('combobox', { name: '搜索标签总览', exact: true }).fill('b.txt');
    assert.ok((await page.locator('.picker-list').textContent()).includes('最近关闭')); await page.keyboard.press('Enter'); await page.getByRole('tab', { name: 'b.txt', exact: true }).waitFor();
    await navigate(fixture); assert.equal(await page.locator('#breadcrumbs button[aria-current]').getAttribute('title'), fixture);
    await page.locator('#pathInput').fill(fixture + '/mo'); await page.waitForFunction(() => document.querySelector('#pathSuggestions option')?.value.endsWith('/moved/'));
    await page.locator('#pathInput').press('Tab'); assert.equal(await page.locator('#pathInput').inputValue(), fixture + '/moved/');
    await page.locator('#pathInput').press('Enter'); await page.getByRole('treeitem', { name: 'b.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: `打开目录 ${fixture}`, exact: true }).click(); await page.getByRole('treeitem', { name: 'a.conf', exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.2-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '命令面板', exact: true }).click();
    await page.screenshot({ path: path.join(outputFolder, 'workbench-1.2-mobile.png') });
    assert.ok((await page.locator('#utilityDialog').boundingBox()).width < 390);
    await closeDialog(); await page.screenshot({ path: path.join(outputFolder, 'workbench-1.2-mobile-workspace.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, checks: ['multi-select-copy', 'move-conflict-and-open-paths', 'recursive-duplicate', 'batch-delete', 'byte-exact-save-as', 'partial-save-all', 'command-palette', 'terminal-cwd-and-rename', 'focus-restore', 'tab-overview-reopen', 'close-kills-pty', 'path-completion-breadcrumbs', 'desktop-mobile'], errors }));
  } finally {
    await cleanup(fixture).catch(error => console.error('Fixture cleanup:', error.message));
    await context.request.post(baseURL + '/api/logout').catch(() => {});
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
