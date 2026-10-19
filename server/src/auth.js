'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'ws_terminal_session';

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function tokenMatches(expected, candidate) {
  if (!expected || !candidate) {
    return false;
  }
  return crypto.timingSafeEqual(digest(expected), digest(candidate));
}

function getCookie(req, name) {
  const prefix = `${name}=`;
  const match = String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  if (!match) {
    return '';
  }
  try {
    return decodeURIComponent(match.slice(prefix.length));
  } catch {
    return '';
  }
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function getClientAddress(req, trustProxy = false) {
  const socketAddress = req.socket.remoteAddress || 'unknown';
  if (trustProxy && isLoopbackAddress(socketAddress)) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return socketAddress;
}

function createAuth(config, now = () => Date.now()) {
  const sessions = new Map();
  const attempts = new Map();
  let revocationHandler = () => {};

  function revokeSession(sessionId, reason) {
    if (!sessionId || !sessions.has(sessionId)) {
      return false;
    }
    sessions.delete(sessionId);
    revocationHandler(sessionId, reason);
    return true;
  }

  function purgeExpired() {
    const current = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= current) {
        revokeSession(id, 'login expired');
      }
    }
    for (const [address, record] of attempts) {
      if (record.blockedUntil <= current && current - record.windowStartedAt > config.auth.loginWindowMs) {
        attempts.delete(address);
      }
    }
  }

  function getSessionId(req) {
    if (!config.auth.required) {
      return null;
    }
    const sessionId = getCookie(req, COOKIE_NAME);
    const session = sessions.get(sessionId);
    if (!session) {
      return '';
    }
    if (session.expiresAt <= now()) {
      revokeSession(sessionId, 'login expired');
      return '';
    }
    return sessionId;
  }

  function verifyRequest(req) {
    return !config.auth.required || Boolean(getSessionId(req));
  }

  function reserveAttemptAddress(address) {
    if (attempts.has(address) || attempts.size < config.auth.maxTrackedAddresses) {
      return;
    }
    attempts.delete(attempts.keys().next().value);
  }

  function enforceSessionLimits(address) {
    const addressSessions = [...sessions.entries()]
      .filter(([, session]) => session.address === address)
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    while (addressSessions.length >= config.auth.maxSessionsPerAddress) {
      const [sessionId] = addressSessions.shift();
      revokeSession(sessionId, 'newer login replaced this session');
    }
    while (sessions.size >= config.auth.maxSessions) {
      const oldest = [...sessions.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
      if (!oldest) {
        break;
      }
      revokeSession(oldest[0], 'login session capacity reached');
    }
  }

  function login(token, address) {
    if (!config.auth.required) {
      return { ok: true, sessionId: '', expiresAt: now() + config.auth.sessionTtlMs };
    }

    purgeExpired();
    const current = now();
    let record = attempts.get(address);
    if (record && record.blockedUntil > current) {
      return { ok: false, rateLimited: true, retryAfterMs: record.blockedUntil - current };
    }
    if (!record || current - record.windowStartedAt > config.auth.loginWindowMs) {
      record = { count: 0, windowStartedAt: current, blockedUntil: 0 };
    }

    if (!tokenMatches(config.auth.token, token)) {
      reserveAttemptAddress(address);
      record.count += 1;
      if (record.count >= config.auth.maxLoginAttempts) {
        record.blockedUntil = current + config.auth.loginBlockMs;
      }
      attempts.set(address, record);
      return {
        ok: false,
        rateLimited: record.blockedUntil > current,
        retryAfterMs: Math.max(0, record.blockedUntil - current)
      };
    }

    attempts.delete(address);
    enforceSessionLimits(address);
    const sessionId = crypto.randomBytes(32).toString('base64url');
    const expiresAt = current + config.auth.sessionTtlMs;
    sessions.set(sessionId, { address, createdAt: current, expiresAt });
    return { ok: true, sessionId, expiresAt };
  }

  function logout(req) {
    const sessionId = getCookie(req, COOKIE_NAME);
    revokeSession(sessionId, 'logged out');
    return sessionId;
  }

  function setRevocationHandler(handler) {
    revocationHandler = typeof handler === 'function' ? handler : () => {};
  }

  return {
    cookieName: COOKIE_NAME,
    getSessionId,
    login,
    logout,
    purgeExpired,
    setRevocationHandler,
    verifyRequest
  };
}

module.exports = {
  COOKIE_NAME,
  createAuth,
  getClientAddress,
  getCookie,
  isLoopbackAddress,
  tokenMatches
};
