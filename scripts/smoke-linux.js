'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const WebSocket = require('ws');

const baseUrl = new URL(process.env.WS_TERMINAL_TEST_URL || 'http://127.0.0.1:8765');
const accessToken = process.env.WS_TERMINAL_TEST_TOKEN || process.env.WS_TERMINAL_TOKEN;

if (!accessToken) {
  process.stderr.write('WS_TERMINAL_TEST_TOKEN or WS_TERMINAL_TOKEN is required\n');
  process.exit(1);
}

function request(pathname, options = {}, body = '') {
  const client = baseUrl.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(new URL(pathname, baseUrl), options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function exerciseTerminal(cookie, options) {
  const wsUrl = new URL('/ws/terminal?cols=100&rows=30', baseUrl);
  if (options.startCwd) wsUrl.searchParams.set('cwd', options.startCwd);
  wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: cookie, Origin: baseUrl.origin }
    });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Terminal ${options.marker} timed out; output=${JSON.stringify(output.slice(-1000))}`));
    }, 10000);
    let output = '';
    let sawRootUser = false;
    let sawCwdChange = false;
    let sawDirectory = false;
    let sawFile = false;

    const finishIfComplete = () => {
      if (!sawRootUser || !sawCwdChange || !sawDirectory || !sawFile || !output.includes(options.marker) || (options.expectedContent && !output.includes(options.expectedContent)) || (options.startCwd && !output.includes(`SMOKE_START=${options.startCwd}`))) {
        return;
      }
      clearTimeout(timeout);
      ws.send(JSON.stringify({ type: 'close' }));
      ws.close(1000, 'smoke test complete');
      resolve();
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'input',
        data: `${options.startCwd ? `printf 'SMOKE_START=%s\\n' "$PWD"` : `cd ${options.cwd}`} && printf 'SMOKE_UID=%s\\n' "$(id -u)" && printf '${options.marker}\\n'${options.expectedContent ? ` && cat ${options.filePath}` : ''}\n`
      }));
      ws.send(JSON.stringify({ type: 'fs:read', requestId: `file-${options.marker}`, path: options.filePath }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'output') {
        output += message.data;
        if (Number.isSafeInteger(message.sequence)) {
          ws.send(JSON.stringify({ type: 'ack', sequence: message.sequence }));
        }
        sawRootUser = /SMOKE_UID=0(?:\r\n|\r|\n)/.test(output);
        finishIfComplete();
        return;
      }
      if (((message.type === 'cwd' && message.path === options.cwd) || (options.startCwd && message.type === 'ready' && message.cwd === options.cwd)) && !sawCwdChange) {
        sawCwdChange = true;
        ws.send(JSON.stringify({ type: 'fs:list', requestId: `dir-${options.marker}`, path: options.cwd }));
        finishIfComplete();
        return;
      }
      if (message.type === 'fs:file' && message.requestId === `file-${options.marker}`) {
        sawFile = message.path === options.filePath && typeof message.content === 'string' && (!options.expectedContent || message.content.includes(options.expectedContent));
        finishIfComplete();
        return;
      }
      if (message.type === 'fs:list' && message.requestId === `dir-${options.marker}`) {
        sawDirectory = message.path === options.cwd && Array.isArray(message.entries);
        finishIfComplete();
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function requestJson(pathname, cookie, options = {}) {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const response = await request(pathname, {
    method: options.method || 'GET',
    headers: {
      Cookie: cookie,
      Origin: baseUrl.origin,
      ...(body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      } : {})
    }
  }, body);
  let payload = {};
  try {
    payload = JSON.parse(response.body || '{}');
  } catch {
    throw new Error(`Invalid JSON from ${pathname}: ${response.body.slice(0, 200)}`);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${pathname} failed with HTTP ${response.statusCode}: ${payload.error || response.body}`);
  }
  return payload;
}

async function exerciseFilesystem(cookie) {
  const directoryName = `ws-terminal-smoke-${process.pid}-${Date.now()}`;
  const directoryPath = `/tmp/${directoryName}`;
  let filePath = `${directoryPath}/note.txt`;
  const mutate = (operation, path, name = '') => requestJson('/api/filesystem/mutate', cookie, {
    method: 'POST',
    body: { operation, path, name }
  });

  const root = await requestJson('/api/filesystem/list?path=%2F', cookie);
  if (root.path !== '/' || !Array.isArray(root.entries)) {
    throw new Error('Root directory is not independently available before creating a terminal');
  }
  const etc = await requestJson('/api/filesystem/list?path=%2Fetc', cookie);
  const hosts = etc.entries.find((entry) => entry.name === 'hosts');
  if (!hosts || hosts.type !== 'file' || !Number.isSafeInteger(hosts.size) || hosts.size < 1) {
    throw new Error('Directory listing did not include the regular file size');
  }

  try {
    await mutate('create-directory', '/tmp', directoryName);
    await mutate('create-file', directoryPath, 'note.txt');
    const initial = await requestJson('/api/filesystem/read', cookie, {
      method: 'POST',
      body: { path: filePath }
    });
    const saved = await requestJson('/api/filesystem/write', cookie, {
      method: 'POST',
      body: {
        path: filePath,
        content: 'filesystem smoke ok\n',
        expectedVersion: initial.version
      }
    });
    if (saved.content !== 'filesystem smoke ok\n') {
      throw new Error('Filesystem smoke save returned unexpected content');
    }
    const renamed = await mutate('rename', filePath, 'renamed.txt');
    filePath = renamed.newPath;
    await mutate('delete', filePath);
    filePath = '';
    await mutate('delete', directoryPath);
  } finally {
    if (filePath) {
      await mutate('delete', filePath).catch(() => {});
    }
    await mutate('delete', directoryPath).catch(() => {});
  }
}

async function exerciseFileOperations(cookie) {
  const root = `/tmp/ws-terminal-batch-${process.pid}-${Date.now()}`;
  const mutate = (operation, target, name) => requestJson('/api/filesystem/mutate', cookie, { method: 'POST', body: { operation, path: target, name } });
  const batch = (operation, paths, destination) => requestJson('/api/filesystem/batch', cookie, { method: 'POST', body: { operation, paths, destination } });
  async function cleanup(target) {
    const listing = await requestJson(`/api/filesystem/list?hidden=1&path=${encodeURIComponent(target)}`, cookie);
    for (const entry of listing.entries) { if (entry.type === 'directory') await cleanup(entry.path); else await mutate('delete', entry.path); }
    await mutate('delete', target);
  }
  try {
    await mutate('create-directory', '/tmp', root.slice(5));
    await mutate('create-directory', root, 'source'); await mutate('create-directory', root, 'destination');
    const content = '\uFEFFbatch smoke\r\n\r\n';
    await requestJson('/api/filesystem/save-as', cookie, { method: 'POST', body: { path: `${root}/source/.hidden`, content } });
    const copied = await batch('copy', [`${root}/source`], `${root}/destination`);
    if (!copied.results[0].ok) throw new Error(`Directory copy failed: ${JSON.stringify(copied)}`);
    const result = await requestJson('/api/filesystem/read', cookie, { method: 'POST', body: { path: `${root}/destination/source/.hidden` } });
    if (result.content !== content) throw new Error('Save As / copy changed file bytes');
    const conflict = await batch('copy', [`${root}/source`], `${root}/destination`);
    if (conflict.results[0].code !== 'EEXIST') throw new Error('Copy silently overwrote its target');
    const moved = await batch('move', [`${root}/source/.hidden`], `${root}/destination`);
    if (!moved.results[0].ok) throw new Error(`Move failed: ${JSON.stringify(moved)}`);
    await exerciseTerminal(cookie, { marker: 'START_DIRECTORY_OK', cwd: root, startCwd: root, filePath: `${root}/destination/.hidden` });
  } finally { await cleanup(root).catch(() => {}); }
}

function exerciseTerminalExit(cookie) {
  const wsUrl = new URL('/ws/terminal?cols=80&rows=24', baseUrl);
  wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: baseUrl.origin } });
    let sawExitMessage = false;
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Terminal exit smoke test timed out'));
    }, 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'input', data: 'exit\n' })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'output' && Number.isSafeInteger(message.sequence)) {
        ws.send(JSON.stringify({ type: 'ack', sequence: message.sequence }));
      }
      if (message.type === 'exit') {
        sawExitMessage = true;
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (!sawExitMessage || code !== 1000 || reason.toString() !== 'process exited') {
        reject(new Error(`Terminal exit did not close cleanly: code=${code} reason=${reason}`));
        return;
      }
      resolve();
    });
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
      if (stat.split(' ')[2] === 'Z') {
        return;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Closed terminal process ${pid} is still running`);
}

function exerciseTerminalClose(cookie) {
  const wsUrl = new URL('/ws/terminal?cols=80&rows=24', baseUrl);
  wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: baseUrl.origin } });
    let output = '';
    let shellPid = null;
    let closeRequested = false;
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Terminal close smoke test timed out; output=${JSON.stringify(output.slice(-500))}`));
    }, 10000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'input', data: `printf 'WS_CLOSE_PID=%s\\n' "$$"\n` }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'output') {
        return;
      }
      output += message.data;
      if (Number.isSafeInteger(message.sequence)) {
        ws.send(JSON.stringify({ type: 'ack', sequence: message.sequence }));
      }
      const match = output.match(/WS_CLOSE_PID=(\d+)(?:\r\n|\r|\n)/);
      if (match && !closeRequested) {
        shellPid = Number.parseInt(match[1], 10);
        closeRequested = true;
        ws.send(JSON.stringify({ type: 'close' }));
      }
    });
    ws.on('close', async () => {
      if (!closeRequested || !shellPid) {
        return;
      }
      try {
        await waitForProcessExit(shellPid);
        clearTimeout(timeout);
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  const health = await request('/api/health');
  if (health.statusCode !== 200) {
    throw new Error(`Health check failed with HTTP ${health.statusCode}`);
  }

  const unauthorizedDrafts = await request('/api/drafts', { headers: { 'X-Draft-Vault': 'a'.repeat(64) } });
  if (unauthorizedDrafts.statusCode !== 401) throw new Error('Draft API is not protected by authentication');

  const loginBody = JSON.stringify({ token: accessToken });
  const login = await request('/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(loginBody),
      Origin: baseUrl.origin
    }
  }, loginBody);
  if (login.statusCode !== 204) {
    throw new Error(`Login failed with HTTP ${login.statusCode}`);
  }

  const cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
  if (!cookie) {
    throw new Error('Login did not return a session cookie');
  }

  const vault = require('node:crypto').randomBytes(32).toString('hex');
  const draftHeaders = { Cookie: cookie, Origin: baseUrl.origin, 'X-Draft-Vault': vault, 'Content-Type': 'application/json' };
  const draft = { path: `/tmp/ws-terminal-api-draft-${process.pid}`, content: '\uFEFFdraft smoke\r\n', baseVersion: 'b'.repeat(64) };
  const blocked = await request('/api/drafts', { headers: { ...draftHeaders, Origin: 'https://not-this-server.invalid' } });
  if (blocked.statusCode !== 403) throw new Error('Cross-origin draft request was not blocked');
  try {
    const saved = await request('/api/drafts', { method: 'PUT', headers: draftHeaders }, JSON.stringify(draft));
    if (saved.statusCode !== 200) throw new Error('Encrypted draft API save failed');
    const listed = JSON.parse((await request('/api/drafts', { headers: draftHeaders })).body);
    if (listed.items.length !== 1 || listed.items[0].content !== draft.content) throw new Error('Draft did not round trip');
    const isolated = JSON.parse((await request('/api/drafts', { headers: { ...draftHeaders, 'X-Draft-Vault': 'c'.repeat(64) } })).body);
    if (isolated.items.length) throw new Error('Draft vault isolation failed');
  } finally { await request('/api/drafts', { method: 'DELETE', headers: draftHeaders }); }

  await Promise.all([
    exerciseTerminal(cookie, { marker: 'TERMINAL_ONE_OK', cwd: '/tmp', filePath: '/etc/hosts' }),
    exerciseTerminal(cookie, { marker: 'TERMINAL_TWO_OK', cwd: '/var/log', filePath: '/etc/hostname' }),
    exerciseFilesystem(cookie),
    exerciseTerminalClose(cookie),
    exerciseTerminalExit(cookie)
  ]);
  await exerciseFileOperations(cookie);

  if (process.env.WS_TERMINAL_TEST_HOST_MODE === '1') {
    const hostFile = `/tmp/ws-terminal-host-proof-${process.pid}-${Date.now()}`;
    const proof = `HOST_PROOF_${require('node:crypto').randomUUID()}`;
    await fs.promises.writeFile(hostFile, proof + '\n', { flag: 'wx', mode: 0o600 });
    try {
      const identity = await requestJson('/api/session', cookie);
      if (identity.node?.mode !== 'host' || identity.node?.user !== 'root') throw new Error('Host identity mismatch');
      const content = await requestJson('/api/filesystem/read', cookie, { method: 'POST', body: { path: hostFile } });
      if (content.content !== proof + '\n') throw new Error('File API does not access the expected host');
      await exerciseTerminal(cookie, { marker: 'HOST_CONTEXT_OK', cwd: '/tmp', filePath: hostFile, expectedContent: proof });
      process.stdout.write('Host shell and file API read the same host-side fixture.\n');
    } finally { await fs.promises.unlink(hostFile); }
  }

  process.stdout.write(`WS Terminal smoke test passed: ${baseUrl.origin}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
