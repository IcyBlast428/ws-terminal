'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadEnvFile, sanitizedEnvironment } = require('../server/src/env-file');

test('loads env values without replacing existing values', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-terminal-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, '.env');
  fs.writeFileSync(filePath, 'PORT=8002\nTOKEN="abc def"\n# ignored\n', 'utf8');
  const target = { PORT: '9000' };

  assert.equal(loadEnvFile(filePath, target), true);
  assert.deepEqual(target, { PORT: '9000', TOKEN: 'abc def' });
});

test('removes service credentials before spawning a shell', () => {
  const result = sanitizedEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/ws-terminal',
    WS_TERMINAL_TOKEN: 'secret',
    OPENAI_API_KEY: 'secret',
    DATABASE_PASSWORD: 'secret',
    LANG: 'C.UTF-8'
  });
  assert.deepEqual(result, {
    PATH: '/usr/bin',
    HOME: '/home/ws-terminal',
    LANG: 'C.UTF-8'
  });
});
