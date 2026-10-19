'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP_VERSION = require('../../package.json').version;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' blob:; worker-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

function send(res, statusCode, body = '', headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendJson(res, statusCode, body, headers = {}) {
  send(res, statusCode, JSON.stringify(body), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
}

function sendStatus(res, statusCode, message, headers = {}) {
  sendJson(res, statusCode, { error: message }, headers);
}

function safeJoin(root, requestPath) {
  let relativePath;
  try {
    relativePath = decodeURIComponent(requestPath).replace(/^[/\\]+/, '');
  } catch {
    return null;
  }
  const resolvedRoot = path.resolve(root);
  const absolutePath = path.resolve(resolvedRoot, relativePath);
  if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`) && absolutePath !== resolvedRoot) {
    return null;
  }
  return absolutePath;
}

function streamFile(req, res, filePath, cacheSeconds = 0) {
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendStatus(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        sendStatus(res, 500, 'File read failed');
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

function createStaticHandler(config, terminalManager, auth) {
  const publicDir = path.join(config.rootDir, 'public');
  const assetsDir = path.join(publicDir, 'assets');
  const nodeModulesDir = path.join(config.rootDir, 'node_modules');
  const vendorFiles = new Map([
    ['/vendor/xterm.css', path.join(nodeModulesDir, '@xterm', 'xterm', 'css', 'xterm.css')],
    ['/vendor/xterm.js', path.join(nodeModulesDir, '@xterm', 'xterm', 'lib', 'xterm.js')],
    ['/vendor/addon-fit.js', path.join(nodeModulesDir, '@xterm', 'addon-fit', 'lib', 'addon-fit.js')]
  ]);

  return function handleHttp(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendStatus(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'ws-terminal', version: APP_VERSION });
      return;
    }

    if (url.pathname === '/api/config') {
      sendJson(res, 200, {
        title: config.title,
        authRequired: config.auth.required,
        maxSessions: config.maxSessions,
        maxFileBytes: config.maxFileBytes
      });
      return;
    }

    if (url.pathname === '/api/session') {
      if (!auth.verifyRequest(req)) {
        sendJson(res, 401, { authenticated: false });
        return;
      }
      sendJson(res, 200, {
        authenticated: true,
        shell: config.shell,
        cwd: config.cwd,
        activeSessions: terminalManager.size(),
        maxSessions: config.maxSessions,
        node: { name: config.nodeName, ip: config.nodeIP || Object.values(os.networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4')?.address || '',
          user: config.hostMode ? 'root' : os.userInfo().username, mode: config.hostMode ? 'host' : process.env.WS_TERMINAL_CONTAINER === '1' ? 'container' : 'host' },
        maxTransferBytes: config.maxTransferBytes,
          maxInputBytes: config.maxInputBytes,
          draftTtlSeconds: config.draftTtlMs / 1000,
        reconnectGraceSeconds: config.reconnectGraceMs / 1000,
        backupCount: config.backupCount
      });
      return;
    }

    if (vendorFiles.has(url.pathname)) {
      streamFile(req, res, vendorFiles.get(url.pathname), 86400);
      return;
    }

    if (url.pathname.startsWith('/assets/')) {
      const filePath = safeJoin(assetsDir, url.pathname.slice('/assets/'.length));
      if (!filePath) {
        sendStatus(res, 403, 'Forbidden');
        return;
      }
      streamFile(req, res, filePath);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (config.auth.required && !auth.verifyRequest(req)) { send(res, 303, '', { Location: '/login' }); return; }
      streamFile(req, res, path.join(publicDir, 'index.html'));
      return;
    }

    if (url.pathname === '/login' || url.pathname === '/login.html') {
      if (!config.auth.required || auth.verifyRequest(req)) { send(res, 303, '', { Location: '/' }); return; }
      streamFile(req, res, path.join(publicDir, 'login.html'));
      return;
    }

    sendStatus(res, 404, 'Not found');
  };
}

module.exports = {
  applySecurityHeaders,
  createStaticHandler,
  send,
  sendJson,
  sendStatus
};
