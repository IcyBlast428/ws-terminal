'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { readConfig } = require('../server/src/config');
const { TerminalManager } = require('../server/src/terminal-manager');

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.messages = []; }
  send(data) { this.messages.push(JSON.parse(data)); }
  close(code, reason) { this.readyState = 3; this.reason = reason; this.emit('close'); }
  terminate() { this.close(1006, ''); }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await wait(20); }
  throw new Error('Condition did not become true');
}

test('retains the same PTY across disconnect, replays output, isolates logins, and closes explicitly', { skip: process.platform !== 'linux' }, async () => {
  const config = readConfig(['node', 'server'], { WS_TERMINAL_TOKEN: 'reconnect-test-token-at-least-24', WS_TERMINAL_SHELL: '/bin/bash', WS_TERMINAL_CWD: '/tmp' });
  const manager = new TerminalManager(config, { log() {}, error() {} });
  const first = new Socket(); const url = new URL('http://localhost/ws/terminal');
  const session = manager.createSession(first, url, {}, '127.0.0.1', 'login-one');
  try {
    assert.equal(manager.ownedSession(session.id, 'login-two'), null);
    first.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'printf "BEFORE_%s\\n" "DETACH"\n' })));
    await until(() => first.messages.some(message => message.type === 'output' && message.data.includes('BEFORE_DETACH')));
    const last = Math.max(...first.messages.filter(message => message.type === 'output').map(message => message.sequence));
    first.close(1006, 'network interrupted');
    assert.equal(manager.size(), 1); assert.equal(session.attached, false);
    session.term.write('printf "AFTER_%s\\n" "DETACH"\n'); await wait(100);
    const resumed = new Socket(); assert.equal(session.attach(resumed, last, true), true);
    assert.equal(resumed.messages[0].id, session.id); assert.equal(resumed.messages[0].resumed, true);
    assert.ok(resumed.messages.some(message => message.type === 'output' && message.data.includes('AFTER_DETACH')));
    assert.ok(resumed.messages.filter(message => message.type === 'output').every(message => message.sequence > last));
    resumed.emit('message', Buffer.from('{"type":"close"}')); assert.equal(manager.size(), 0);
    await until(() => { try { process.kill(session.term.pid, 0); return false; } catch { return true; } });
  } finally { manager.shutdown(); }
});

test('expires detached terminals and revokes disconnected sessions on logout', { skip: process.platform !== 'linux' }, async () => {
  const config = readConfig(['node', 'server'], { WS_TERMINAL_TOKEN: 'reconnect-test-token-at-least-24', WS_TERMINAL_CWD: '/tmp' });
  config.reconnectGraceMs = 40;
  const manager = new TerminalManager(config, { log() {}, error() {} });
  try {
    const socket = new Socket(); manager.createSession(socket, new URL('http://localhost/ws/terminal'), {}, 'local', 'owner');
    socket.close(); await until(() => manager.size() === 0);
    const second = new Socket(); manager.createSession(second, new URL('http://localhost/ws/terminal'), {}, 'local', 'owner');
    second.close(); assert.equal(manager.closeByAuthSession('owner'), 1); assert.equal(manager.size(), 0);
  } finally { manager.shutdown(); }
});
