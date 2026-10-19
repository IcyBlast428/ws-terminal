'use strict';

const http = require('node:http');
const path = require('node:path');
const { FileService } = require('./file-service');
const { DraftStore } = require('./draft-store');
const { configureFilesystem } = require('./filesystem-context');

const { WebSocketServer } = require('ws');

const { createAuth, getClientAddress } = require('./auth');
const { readConfig } = require('./config');
const { loadEnvFile } = require('./env-file');
const logger = require('./logger');
const { applySecurityHeaders, createStaticHandler, send, sendJson, sendStatus } = require('./static');
const {
  createEntry,
  deleteEntry,
  directoryErrorMessage,
  listDirectory,
  readTextFile,
  renameEntry,
  TerminalManager,
  writeTextFile
} = require('./terminal-manager');

function rejectUpgrade(socket, statusCode, message) {
  const reason = http.STATUS_CODES[statusCode] || 'Error';
  const body = JSON.stringify({ error: message });
  socket.end([
    `HTTP/1.1 ${statusCode} ${reason}`,
    'Connection: close',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
}

function sameHostOrigin(origin, host) {
  if (!origin || !host) {
    return true;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function originAllowed(req, config) {
  const origin = req.headers.origin;
  return !origin || sameHostOrigin(origin, req.headers.host) || config.allowedOrigins.includes(origin);
}

function secureRequest(req, config) {
  if (config.secureCookie === 'true') {
    return true;
  }
  if (config.secureCookie === 'false') {
    return false;
  }
  if (req.socket.encrypted) {
    return true;
  }
  return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(config, req, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (secureRequest(req, config)) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function readJson(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) {
        return;
      }
      length += chunk.length;
      if (length > maxBytes) {
        failed = true;
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) {
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function filesystemStatus(error) {
  if (error?.code === 'ENOENT') {
    return 404;
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return 403;
  }
  if (error?.code === 'ENOTDIR') {
    return 400;
  }
  if (error?.code === 'EFBIG') {
    return 413;
  }
  if (error?.code === 'ESTALE' || error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
    return 409;
  }
  if (error?.code === 'EINVAL') {
    return 400;
  }
  if (error?.code === 'EISDIR' || error?.code === 'EISBINARY' || error?.code === 'EILSEQ') {
    return 415;
  }
  return 500;
}

function handleFilesystemApi(req, res, url, config, auth, limiter, fileService) {
  if (!url.pathname.startsWith('/api/filesystem/')) {
    return false;
  }
  if (!auth.verifyRequest(req)) {
    sendStatus(res, 401, 'Unauthorized');
    return true;
  }
  if (!originAllowed(req, config)) {
    sendStatus(res, 403, 'Origin not allowed');
    return true;
  }
  if (limiter.active >= limiter.maximum) {
    sendStatus(res, 429, 'Too many filesystem requests');
    return true;
  }

  let operation;
  if (url.pathname === '/api/filesystem/preview' && ['GET', 'HEAD'].includes(req.method)) {
    limiter.active++;
    fileService.preview(url.searchParams.get('path'), req, res).catch(error => {
      if (!res.headersSent) sendStatus(res, filesystemStatus(error), error.message); else res.destroy();
    }).finally(() => { limiter.active--; });
    return true;
  } else if (url.pathname === '/api/filesystem/list' && req.method === 'GET') {
    operation = Promise.resolve().then(() => listDirectory(url.searchParams.get('path'), config.maxDirectoryEntries, url.searchParams.get('hidden') === '1', {
      offset: url.searchParams.get('offset') || 0, query: url.searchParams.get('query') || '', revision: url.searchParams.get('revision') || ''
    }));
  } else if (url.pathname === '/api/filesystem/stat' && req.method === 'GET') {
    operation = fileService.metadata(url.searchParams.get('path'));
  } else if (url.pathname === '/api/filesystem/size' && req.method === 'GET') {
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', abort);
    operation = fileService.directorySize(url.searchParams.get('path'), controller.signal).finally(() => res.removeListener('close', abort));
  } else if (url.pathname === '/api/filesystem/history' && req.method === 'GET') {
    operation = fileService.backups(url.searchParams.get('path')).then(items => ({ items }));
  } else if (url.pathname === '/api/filesystem/backup' && req.method === 'GET') {
    operation = fileService.backupContent(url.searchParams.get('path'), url.searchParams.get('id'));
  } else if (url.pathname === '/api/filesystem/restore' && req.method === 'POST') {
    operation = readJson(req).then(payload => fileService.restore(payload.path, payload.id, payload.expectedVersion));
  } else if (url.pathname === '/api/filesystem/upload' && req.method === 'POST') {
    if (Number(req.headers['content-length']) > config.maxTransferBytes) { sendStatus(res, 413, 'Transfer size limit exceeded'); return true; }
    operation = fileService.upload(url.searchParams.get('path'), req, url.searchParams.get('overwrite') === '1', url.searchParams.get('expectedFingerprint'));
  } else if (url.pathname === '/api/filesystem/download' && req.method === 'GET') {
    limiter.active += 1;
    fileService.download(url.searchParams.get('path'), req, res).then(result => {
      logger.log('filesystem.download', { ...result, remoteAddress: getClientAddress(req, config.trustProxy) });
    }).catch(error => { if (!res.headersSent) sendStatus(res, filesystemStatus(error), error.message); else res.destroy(); })
      .finally(() => { limiter.active -= 1; });
    return true;
  } else if (url.pathname === '/api/filesystem/read' && req.method === 'POST') {
    operation = readJson(req).then((payload) => {
      if (typeof payload.path !== 'string') {
        throw Object.assign(new Error('Invalid file path'), { code: 'EINVAL' });
      }
      return readTextFile(payload.path, config.maxFileBytes);
    });
  } else if (url.pathname === '/api/filesystem/write' && req.method === 'POST') {
    operation = readJson(req, config.maxClientMessageBytes).then((payload) => {
      if (typeof payload.path !== 'string' || typeof payload.content !== 'string' || typeof payload.expectedVersion !== 'string') {
        throw Object.assign(new Error('Invalid file write request'), { code: 'EINVAL' });
      }
      return fileService.write(payload.path, payload.content, payload.expectedVersion);
    });
  } else if (url.pathname === '/api/filesystem/save-as' && req.method === 'POST') {
    operation = readJson(req, config.maxClientMessageBytes).then(payload => {
      if (!payload || typeof payload.path !== 'string' || typeof payload.content !== 'string') throw Object.assign(new Error('Invalid Save As request'), { code: 'EINVAL' });
      return fileService.saveAs(payload.path, payload.content);
    });
  } else if (url.pathname === '/api/filesystem/batch' && req.method === 'POST') {
    operation = readJson(req, 65536).then(payload => fileService.operations.batch(payload));
  } else if (url.pathname === '/api/filesystem/mutate' && req.method === 'POST') {
    operation = readJson(req).then((payload) => {
      if (typeof payload.path !== 'string' || (payload.name !== undefined && typeof payload.name !== 'string')) {
        throw Object.assign(new Error('Invalid file operation'), { code: 'EINVAL' });
      }
      if (payload.operation === 'create-file') {
        return createEntry(payload.path, payload.name, 'file');
      }
      if (payload.operation === 'create-directory') {
        return createEntry(payload.path, payload.name, 'directory');
      }
      if (payload.operation === 'rename') {
        return renameEntry(payload.path, payload.name);
      }
      if (payload.operation === 'delete') {
        return deleteEntry(payload.path);
      }
      const error = new Error('Invalid file operation');
      error.code = 'EINVAL';
      throw error;
    });
  } else {
    sendStatus(res, 405, 'Method not allowed');
    return true;
  }

  limiter.active += 1;
  operation.then((result) => {
    const source = { remoteAddress: getClientAddress(req, config.trustProxy), transport: 'http' };
    if (url.pathname === '/api/filesystem/batch') {
      logger.log('filesystem.batch', { operation: result.operation, results: result.results, ...source });
    } else if (url.pathname === '/api/filesystem/save-as') {
      logger.log('filesystem.saved_as', { path: result.path, size: result.size, ...source });
    } else if (url.pathname === '/api/filesystem/write' || url.pathname === '/api/filesystem/restore') {
      logger.log(url.pathname.endsWith('/restore') ? 'filesystem.restored' : 'filesystem.file_saved', { path: result.path, size: result.size, ...source });
    } else if (url.pathname === '/api/filesystem/mutate') {
      logger.log('filesystem.mutated', { ...result, ...source });
    } else if (url.pathname === '/api/filesystem/upload') {
      logger.log('filesystem.uploaded', { ...result, ...source });
    }
    sendJson(res, 200, result);
  }).catch((error) => {
    sendStatus(res, error.statusCode || filesystemStatus(error), directoryErrorMessage(error));
  }).finally(() => {
    limiter.active = Math.max(0, limiter.active - 1);
  });
  return true;
}

function main() {
  loadEnvFile(path.resolve(__dirname, '..', '..', '.env'));
  const config = readConfig();
  configureFilesystem(config);
  logger.configure(config.nodeName);
  const auth = createAuth(config);
  const fileService = new FileService(config);
  const drafts = new DraftStore(config);
  drafts.prune().catch(error => logger.error('drafts.cleanup_failed', error));
  const terminalManager = new TerminalManager(config, logger, fileService);
  const filesystemLimiter = {
    active: 0,
    maximum: Math.max(2, config.maxDirectoryRequests + config.maxFileRequests)
  };
  auth.setRevocationHandler((sessionId, reason) => {
    const closedTerminals = terminalManager.closeByAuthSession(sessionId, reason);
    if (closedTerminals > 0) {
      logger.log('auth.terminals_revoked', { reason, closedTerminals });
    }
  });
  const handleHttp = createStaticHandler(config, terminalManager, auth);

  const server = http.createServer((req, res) => {
    applySecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendStatus(res, 400, 'Invalid URL');
      return;
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!originAllowed(req, config)) {
        sendStatus(res, 403, 'Origin not allowed');
        return;
      }
      readJson(req).then((payload) => {
        const remoteAddress = getClientAddress(req, config.trustProxy);
        const result = auth.login(payload.token, remoteAddress);
        if (!result.ok) {
          logger.log('auth.login_failed', { remoteAddress, rateLimited: result.rateLimited });
          const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
          sendJson(res, result.rateLimited ? 429 : 401, { ok: false }, result.rateLimited ? { 'Retry-After': retryAfter } : {});
          return;
        }
        logger.log('auth.login_succeeded', { remoteAddress });
        send(res, 204, '', {
          'Set-Cookie': sessionCookie(config, req, auth.cookieName, result.sessionId, config.auth.sessionTtlMs / 1000)
        });
      }).catch((err) => sendStatus(res, err.statusCode || 400, err.message));
      return;
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (!originAllowed(req, config)) {
        sendStatus(res, 403, 'Origin not allowed');
        return;
      }
      auth.logout(req);
      send(res, 204, '', {
        'Set-Cookie': sessionCookie(config, req, auth.cookieName, '', 0)
      });
      return;
    }

    if (url.pathname === '/api/drafts') {
      if (!auth.verifyRequest(req)) { sendStatus(res, 401, 'Unauthorized'); return; }
      if (!originAllowed(req, config)) { sendStatus(res, 403, 'Origin not allowed'); return; }
      if (filesystemLimiter.active >= filesystemLimiter.maximum) { sendStatus(res, 429, 'Too many filesystem requests'); return; }
      filesystemLimiter.active++;
      const vault = req.headers['x-draft-vault'];
      Promise.resolve().then(async () => {
        if (req.method === 'GET') return { items: await drafts.list(vault) };
        if (req.method === 'PUT') return drafts.put(vault, await readJson(req, config.maxClientMessageBytes));
        if (req.method === 'DELETE') { await drafts.remove(vault, url.searchParams.get('path')); return { ok: true }; }
        throw Object.assign(new Error('Method not allowed'), { statusCode: 405 });
      }).then(result => sendJson(res, 200, result)).catch(error => sendStatus(res, error.statusCode || filesystemStatus(error), error.message))
        .finally(() => { filesystemLimiter.active--; });
      return;
    }

    if (url.pathname === '/api/terminals' || url.pathname === '/api/audit') {
      if (!auth.verifyRequest(req)) { sendStatus(res, 401, 'Unauthorized'); return; }
      if (!originAllowed(req, config)) { sendStatus(res, 403, 'Origin not allowed'); return; }
      const owner = auth.getSessionId(req);
      if (url.pathname === '/api/audit' && req.method === 'GET') sendJson(res, 200, { items: logger.recent() });
      else if (req.method === 'GET') sendJson(res, 200, { sessions: terminalManager.listSessions(owner) });
      else if (url.pathname === '/api/terminals' && req.method === 'DELETE') {
        const terminal = terminalManager.ownedSession(url.searchParams.get('id'), owner);
        if (!terminal) sendStatus(res, 404, 'Terminal session expired');
        else { terminal.close('closed by session manager'); sendJson(res, 200, { ok: true }); }
      } else sendStatus(res, 405, 'Method not allowed');
      return;
    }

    if (handleFilesystemApi(req, res, url, config, auth, filesystemLimiter, fileService)) {
      return;
    }

    try {
      handleHttp(req, res, url);
    } catch (err) {
      logger.error('http.request_failed', err, { path: url.pathname });
      if (!res.headersSent) {
        sendStatus(res, 500, 'Internal server error');
      } else {
        res.destroy();
      }
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: config.maxClientMessageBytes
  });

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      rejectUpgrade(socket, 400, 'Invalid URL');
      return;
    }

    if (url.pathname !== '/ws/terminal') {
      rejectUpgrade(socket, 404, 'Not found');
      return;
    }
    if (!originAllowed(req, config)) {
      rejectUpgrade(socket, 403, 'Origin not allowed');
      return;
    }
    const authSessionId = auth.getSessionId(req);
    if (config.auth.required && !authSessionId) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const resumeId = url.searchParams.get('session');
    if (resumeId && !terminalManager.ownedSession(resumeId, authSessionId)) {
      rejectUpgrade(socket, 404, 'Terminal session expired'); return;
    }
    if (!resumeId && !terminalManager.canCreateSession()) {
      rejectUpgrade(socket, 429, 'Too many sessions');
      return;
    }

    let cwd = null;
    if (!resumeId && url.searchParams.has('cwd')) {
      if (filesystemLimiter.active >= filesystemLimiter.maximum) { rejectUpgrade(socket, 429, 'Too many filesystem requests'); return; }
      filesystemLimiter.active++;
      const onError = () => {};
      socket.on('error', onError);
      try {
        const directory = await fileService.metadata(url.searchParams.get('cwd'));
        if (directory.type !== 'directory') throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
        cwd = directory.path;
      } catch (error) {
        if (!socket.destroyed) rejectUpgrade(socket, filesystemStatus(error), 'Invalid terminal working directory');
        return;
      } finally { filesystemLimiter.active--; socket.removeListener('error', onError); }
    }
    if (socket.destroyed) return;
    if (config.auth.required && auth.getSessionId(req) !== authSessionId) { rejectUpgrade(socket, 401, 'Unauthorized'); return; }
    if (!resumeId && !terminalManager.canCreateSession()) { rejectUpgrade(socket, 429, 'Too many sessions'); return; }
    // Validate before the handshake so the first input frame cannot arrive before PTY listeners.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url, authSessionId, cwd);
    });
  });

  wss.on('connection', (ws, req, url, authSessionId, cwd) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    try {
      const resumeId = url.searchParams.get('session');
      if (resumeId) {
        const terminal = terminalManager.ownedSession(resumeId, authSessionId);
        if (!terminal) { ws.close(1000, 'terminal session expired'); return; }
        const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
        terminal.attach(ws, after, true);
      } else {
        if (ws.readyState !== 1) return;
        if (config.auth.required && auth.getSessionId(req) !== authSessionId) { ws.close(1008, 'terminal session expired'); return; }
        if (!terminalManager.canCreateSession()) { ws.close(1008, 'Too many sessions'); return; }
        terminalManager.createSession(ws, url, req, getClientAddress(req, config.trustProxy), authSessionId, cwd);
      }
    } catch (err) {
      logger.error('terminal.spawn_failed', err, { remoteAddress: getClientAddress(req, config.trustProxy) });
      ws.close(1011, 'Failed to start shell');
    }
  });

  const heartbeat = setInterval(() => {
    auth.purgeExpired();
    drafts.prune().catch(error => logger.error('drafts.cleanup_failed', error));
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref?.();

  server.on('clientError', (err, socket) => {
    logger.error('http.client_error', err);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });
  let serverStarted = false;

  server.on('error', (err) => {
    logger.error('server.error', err);
    if (!serverStarted) {
      process.exitCode = 1;
    }
  });

  server.listen(config.port, config.host, () => {
    serverStarted = true;
    logger.log('server.started', {
      host: config.host,
      port: config.port,
      shell: config.shell,
      cwd: config.cwd,
      authRequired: config.auth.required
    });
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.log('server.stopping', { signal });
    clearInterval(heartbeat);
    terminalManager.shutdown();
    for (const ws of wss.clients) {
      ws.terminate();
    }
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  logger.error('server.start_failed', err);
  process.exitCode = 1;
}
