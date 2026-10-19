'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readConfig, splitShellArgs } = require('../server/src/config');

const VALID_TOKEN = '0123456789abcdefghijklmnop';

test('reads host and port command-line overrides', () => {
  const config = readConfig(
    ['node', 'server', '--host', '0.0.0.0', '--port', '8002'],
    { WS_TERMINAL_TOKEN: VALID_TOKEN, WS_TERMINAL_SHELL: '/bin/bash' }
  );
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8002);
});

test('rejects missing and weak access tokens', () => {
  assert.throws(
    () => readConfig(['node', 'server'], { WS_TERMINAL_SHELL: '/bin/bash' }),
    /WS_TERMINAL_TOKEN is required/
  );
  assert.throws(
    () => readConfig(['node', 'server'], { WS_TERMINAL_SHELL: '/bin/bash', WS_TERMINAL_TOKEN: 'too-short' }),
    /at least 24 characters/
  );
  assert.throws(
    () => readConfig(['node', 'server'], {
      WS_TERMINAL_SHELL: '/bin/bash',
      WS_TERMINAL_TOKEN: 'replace-with-output-from-openssl-rand-base64-32'
    }),
    /unsafe placeholder/
  );
});

test('requires an explicit second switch before disabling auth', () => {
  assert.throws(
    () => readConfig(['node', 'server'], { WS_TERMINAL_SHELL: '/bin/bash', WS_TERMINAL_NO_AUTH: '1' }),
    /ALLOW_UNSAFE_NO_AUTH/
  );
  const config = readConfig(['node', 'server'], {
    WS_TERMINAL_SHELL: '/bin/bash',
    WS_TERMINAL_NO_AUTH: '1',
    WS_TERMINAL_ALLOW_UNSAFE_NO_AUTH: '1'
  });
  assert.equal(config.auth.required, false);
});

test('splits quoted shell arguments', () => {
  assert.deepEqual(splitShellArgs('-l -c "echo ok"'), ['-l', '-c', 'echo ok']);
});
