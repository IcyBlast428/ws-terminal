'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuth, getClientAddress, tokenMatches } = require('../server/src/auth');

function requestWithCookie(cookie = '') {
  return { headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } };
}

function config() {
  return {
    auth: {
      required: true,
      token: '0123456789abcdefghijklmnop',
      sessionTtlMs: 1000,
      maxSessions: 4,
      maxSessionsPerAddress: 2,
      maxLoginAttempts: 2,
      loginWindowMs: 1000,
      loginBlockMs: 5000,
      maxTrackedAddresses: 16
    }
  };
}

test('uses constant-length token digests for comparison', () => {
  assert.equal(tokenMatches('correct-token', 'correct-token'), true);
  assert.equal(tokenMatches('correct-token', 'wrong-token'), false);
});

test('exchanges the access token for an expiring opaque session', () => {
  let current = 1000;
  const auth = createAuth(config(), () => current);
  const result = auth.login(config().auth.token, '10.0.0.2');
  assert.equal(result.ok, true);
  assert.equal(result.sessionId.length > 30, true);

  const req = requestWithCookie(`${auth.cookieName}=${result.sessionId}`);
  assert.equal(auth.verifyRequest(req), true);
  current = 2501;
  assert.equal(auth.verifyRequest(req), false);
});

test('rate limits repeated failed logins', () => {
  const auth = createAuth(config(), () => 1000);
  assert.deepEqual(auth.login('wrong', '10.0.0.3').rateLimited, false);
  assert.deepEqual(auth.login('wrong', '10.0.0.3').rateLimited, true);
  assert.deepEqual(auth.login(config().auth.token, '10.0.0.3').rateLimited, true);
});

test('trusts forwarded addresses only when explicitly enabled', () => {
  const req = {
    headers: { 'x-forwarded-for': '10.0.0.9, 127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(getClientAddress(req, false), '127.0.0.1');
  assert.equal(getClientAddress(req, true), '10.0.0.9');
});

test('ignores forwarded addresses when the proxy connection is not local', () => {
  const req = {
    headers: { 'x-forwarded-for': '10.0.0.9' },
    socket: { remoteAddress: '10.0.0.8' }
  };
  assert.equal(getClientAddress(req, true), '10.0.0.8');
});

test('revokes sessions on logout and expiry', () => {
  let current = 1000;
  const auth = createAuth(config(), () => current);
  const revoked = [];
  auth.setRevocationHandler((sessionId, reason) => revoked.push({ sessionId, reason }));

  const login = auth.login(config().auth.token, '10.0.0.4');
  const req = requestWithCookie(`${auth.cookieName}=${login.sessionId}`);
  auth.logout(req);
  assert.deepEqual(revoked, [{ sessionId: login.sessionId, reason: 'logged out' }]);

  const expiring = auth.login(config().auth.token, '10.0.0.4');
  current = 2001;
  auth.purgeExpired();
  assert.equal(revoked.at(-1).sessionId, expiring.sessionId);
  assert.equal(revoked.at(-1).reason, 'login expired');
});

test('bounds login sessions per source address', () => {
  const auth = createAuth(config(), (() => {
    let current = 1000;
    return () => current++;
  })());
  const revoked = [];
  auth.setRevocationHandler((sessionId, reason) => revoked.push({ sessionId, reason }));
  auth.login(config().auth.token, '10.0.0.5');
  auth.login(config().auth.token, '10.0.0.5');
  auth.login(config().auth.token, '10.0.0.5');
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].reason, 'newer login replaced this session');
});
