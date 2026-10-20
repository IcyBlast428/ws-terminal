'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, baseURL, token, outputFolder, browserOptions } = require('./browser-test-support.cjs');

async function main() {
  await fs.mkdir(outputFolder, { recursive: true });
  const browser = await chromium.launch(browserOptions);
  const errors = []; const external = [];
  const pixels = page => page.locator('#loginRain').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; let hash = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i + 3] > 10) count++; hash = (hash * 31 + data[i + 3]) | 0; }
    return { count, hash, width: canvas.width, height: canvas.height };
  });
  async function open(options = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL).origin) external.push(request.url()); });
    return { context, page };
  }
  try {
    const { context, page } = await open();
    await page.goto(baseURL); await page.waitForURL(url => url.pathname === '/login');
    await page.getByRole('heading', { name: 'WSTerm', exact: true }).waitFor();
    assert.equal(await page.title(), '登录 · WSTerm');
    assert.equal(await page.locator('.auth-host').count(), 0);
    assert.equal(await page.locator('body').innerText().then(text => text.includes(new URL(baseURL).host)), false);
    assert.equal(await page.locator('#loginRain').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#loginMount').evaluate(node => getComputedStyle(node).filter), 'none');
    const first = await pixels(page); assert.ok(first.count > 500, 'rain must contain real visible pixels');
    await page.waitForTimeout(250); assert.notEqual((await pixels(page)).hash, first.hash, 'rain must move');
    await page.screenshot({ path: path.join(outputFolder, 'login-rain-desktop.png') });
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport); await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const bounds = await page.locator('.auth-form').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      assert.ok((await pixels(page)).count > 100);
      await page.locator('#tokenInput').fill('typing-check');
      assert.equal(await page.locator('#tokenInput').inputValue(), 'typing-check');
      await page.locator('#tokenInput').fill('');
      await page.screenshot({ path: path.join(outputFolder, `login-rain-${viewport.width}.png`) });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(80); const frozen = await pixels(page);
    await page.waitForTimeout(250); assert.equal((await pixels(page)).hash, frozen.hash, 'reduce-motion must stop animation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(250); assert.notEqual((await pixels(page)).hash, frozen.hash, 'animation must resume');
    const light = await open({ reducedMotion: 'reduce' });
    await light.context.addInitScript(() => localStorage.setItem('ws-terminal-preferences', JSON.stringify({ theme: 'light' })));
    await light.page.goto(baseURL + '/login'); await light.page.getByRole('heading', { name: 'WSTerm', exact: true }).waitFor();
    assert.equal(await light.page.locator('html').getAttribute('data-theme'), 'light');
    const staticFrame = await pixels(light.page); assert.ok(staticFrame.count > 500);
    await light.page.waitForTimeout(250); assert.equal((await pixels(light.page)).hash, staticFrame.hash);
    await light.page.screenshot({ path: path.join(outputFolder, 'login-rain-light-reduced.png') });
    await light.context.close();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill(token);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/');
    await page.waitForFunction(() => document.querySelector('#nodeIdentity')?.textContent.includes('root'));
    assert.equal(await page.locator('#loginRain').count(), 0);
    assert.equal(await page.locator('.terminal-pane').count(), 0);
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/login');
    await page.getByRole('heading', { name: 'WSTerm', exact: true }).waitFor();
    assert.ok((await pixels(page)).count > 500);
    await context.close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(JSON.stringify({ ok: true, checks: ['WSTerm-title-no-host', 'canvas-pixels-and-motion', 'unblurred-interactive-form', 'desktop-mobile-landscape', 'light-theme', 'live-reduced-motion-change', 'login-logout-no-auto-terminal', 'offline-no-external-requests'] }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
