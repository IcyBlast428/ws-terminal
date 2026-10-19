'use strict';
const path = require('node:path');
const { chromium } = require(process.env.WS_TERMINAL_PLAYWRIGHT_PATH || 'playwright-core');
const token = process.env.WS_TERMINAL_TEST_TOKEN || process.env.WS_TERMINAL_TOKEN;
if (!token) throw new Error('Set WS_TERMINAL_TEST_TOKEN for browser acceptance tests.');
module.exports = {
  chromium, token,
  baseURL: process.env.WS_TERMINAL_TEST_URL || 'http://127.0.0.1:8002',
  outputFolder: process.env.WS_TERMINAL_QA_DIR || path.resolve(__dirname, '../test-results'),
  browserOptions: { headless: true, ...(process.env.WS_TERMINAL_BROWSER_PATH ? { executablePath: process.env.WS_TERMINAL_BROWSER_PATH } : {}) }
};
