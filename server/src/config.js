'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function argValue(argv, longName, shortName) {
  const longPrefix = `${longName}=`;
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === longName || (shortName && item === shortName)) {
      return argv[index + 1];
    }
    if (item.startsWith(longPrefix)) {
      return item.slice(longPrefix.length);
    }
  }
  return undefined;
}

function intValue(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function boolValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function splitShellArgs(value) {
  if (!value || !String(value).trim()) {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of String(value)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped) {
    current += '\\';
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function defaultShell(env) {
  if (env.WS_TERMINAL_SHELL) {
    return env.WS_TERMINAL_SHELL;
  }
  if (env.SHELL) {
    return env.SHELL;
  }
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

function validateConfig(config) {
  if (config.auth.required) {
    if (!config.auth.token) {
      throw new Error('WS_TERMINAL_TOKEN is required');
    }
    if (config.auth.token.length < 24) {
      throw new Error('WS_TERMINAL_TOKEN must contain at least 24 characters');
    }
    const normalizedToken = config.auth.token.toLowerCase();
    if (['change-me', 'replace-me', 'your-token'].includes(normalizedToken) || /^(change|replace|your)[-_]/.test(normalizedToken)) {
      throw new Error('WS_TERMINAL_TOKEN still uses an unsafe placeholder');
    }
  } else if (!config.auth.allowUnsafeNoAuth) {
    throw new Error('Disabling authentication also requires WS_TERMINAL_ALLOW_UNSAFE_NO_AUTH=1');
  }

  if (!path.isAbsolute(config.shell)) {
    throw new Error('WS_TERMINAL_SHELL must be an absolute path');
  }
  return config;
}

function readConfig(argv = process.argv, env = process.env) {
  const noAuth = boolValue(env.WS_TERMINAL_NO_AUTH);
  const config = {
    host: argValue(argv, '--host', '-H') || env.WS_TERMINAL_HOST || '127.0.0.1',
    port: intValue(argValue(argv, '--port', '-p') || env.WS_TERMINAL_PORT, 8765, 1, 65535),
    rootDir: path.resolve(__dirname, '..', '..'),
    shell: defaultShell(env),
    shellArgs: splitShellArgs(env.WS_TERMINAL_SHELL_ARGS || '-l'),
    cwd: env.WS_TERMINAL_CWD || env.HOME || os.homedir() || process.cwd(),
    maxSessions: intValue(env.WS_TERMINAL_MAX_SESSIONS, 8, 1, 100),
    idleTimeoutMs: intValue(env.WS_TERMINAL_IDLE_TIMEOUT_SECONDS, 3600, 30, 86400) * 1000,
    maxSessionDurationMs: intValue(env.WS_TERMINAL_MAX_SESSION_SECONDS, 28800, 300, 604800) * 1000,
    defaultCols: intValue(env.WS_TERMINAL_DEFAULT_COLS, 100, 20, 500),
    defaultRows: intValue(env.WS_TERMINAL_DEFAULT_ROWS, 30, 5, 200),
    maxInputBytes: intValue(env.WS_TERMINAL_MAX_INPUT_BYTES, 65536, 1024, 1048576),
    maxDirectoryEntries: intValue(env.WS_TERMINAL_MAX_DIRECTORY_ENTRIES, 500, 50, 2000),
    maxDirectoryRequests: intValue(env.WS_TERMINAL_MAX_DIRECTORY_REQUESTS, 4, 1, 16),
    maxFileBytes: intValue(env.WS_TERMINAL_MAX_FILE_BYTES, 1048576, 4096, 8388608),
    hostMode: boolValue(env.WS_TERMINAL_HOST_MODE),
    reconnectGraceMs: intValue(env.WS_TERMINAL_RECONNECT_GRACE_SECONDS, 300, 5, 3600) * 1000,
    replayBytes: intValue(env.WS_TERMINAL_REPLAY_BYTES, 1048576, 65536, 8388608),
    maxTransferBytes: intValue(env.WS_TERMINAL_MAX_TRANSFER_BYTES, 104857600, 1024, 1073741824),
    maxCopyEntries: intValue(env.WS_TERMINAL_MAX_COPY_ENTRIES, 10000, 1, 100000),
    backupDir: path.resolve(env.WS_TERMINAL_BACKUP_DIR || '/var/lib/ws-terminal/backups'),
    backupCount: intValue(env.WS_TERMINAL_BACKUP_COUNT, 10, 0, 100),
    backupMaxBytes: intValue(env.WS_TERMINAL_BACKUP_MAX_BYTES, 268435456, 1048576, 1073741824),
    draftDir: path.resolve(env.WS_TERMINAL_DRAFT_DIR || '/var/lib/ws-terminal/drafts'),
    draftTtlMs: intValue(env.WS_TERMINAL_DRAFT_TTL_SECONDS, 3600, 60, 86400) * 1000,
    nodeName: env.WS_TERMINAL_NODE_NAME || os.hostname(),
    nodeIP: env.WS_TERMINAL_NODE_IP || '',
    maxFileRequests: intValue(env.WS_TERMINAL_MAX_FILE_REQUESTS, 2, 1, 8),
    wsHighWaterBytes: intValue(env.WS_TERMINAL_WS_HIGH_WATER_BYTES, 1048576, 65536, 16777216),
    wsLowWaterBytes: intValue(env.WS_TERMINAL_WS_LOW_WATER_BYTES, 262144, 16384, 8388608),
    heartbeatMs: intValue(env.WS_TERMINAL_HEARTBEAT_SECONDS, 30, 10, 300) * 1000,
    title: env.WS_TERMINAL_TITLE || os.hostname(),
    trustProxy: boolValue(env.WS_TERMINAL_TRUST_PROXY),
    secureCookie: String(env.WS_TERMINAL_SECURE_COOKIE || 'auto').toLowerCase(),
    auth: {
      required: !noAuth,
      allowUnsafeNoAuth: boolValue(env.WS_TERMINAL_ALLOW_UNSAFE_NO_AUTH),
      token: env.WS_TERMINAL_TOKEN || '',
      sessionTtlMs: intValue(env.WS_TERMINAL_LOGIN_TTL_SECONDS, 28800, 300, 604800) * 1000,
      maxSessions: intValue(env.WS_TERMINAL_MAX_LOGIN_SESSIONS, 256, 1, 10000),
      maxSessionsPerAddress: intValue(env.WS_TERMINAL_MAX_LOGIN_SESSIONS_PER_ADDRESS, 8, 1, 100),
      maxLoginAttempts: intValue(env.WS_TERMINAL_MAX_LOGIN_ATTEMPTS, 5, 1, 100),
      loginWindowMs: intValue(env.WS_TERMINAL_LOGIN_WINDOW_SECONDS, 60, 10, 3600) * 1000,
      loginBlockMs: intValue(env.WS_TERMINAL_LOGIN_BLOCK_SECONDS, 300, 10, 86400) * 1000,
      maxTrackedAddresses: intValue(env.WS_TERMINAL_MAX_TRACKED_LOGIN_ADDRESSES, 1024, 16, 100000)
    },
    allowedOrigins: String(env.WS_TERMINAL_ALLOWED_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  };

  config.maxClientMessageBytes = Math.max(
    config.maxInputBytes + 4096,
    (config.maxFileBytes * 6) + 8192
  );

  if (!['auto', 'true', 'false'].includes(config.secureCookie)) {
    throw new Error('WS_TERMINAL_SECURE_COOKIE must be auto, true, or false');
  }
  if (config.wsLowWaterBytes >= config.wsHighWaterBytes) {
    throw new Error('WS_TERMINAL_WS_LOW_WATER_BYTES must be lower than WS_TERMINAL_WS_HIGH_WATER_BYTES');
  }
  return validateConfig(config);
}

module.exports = {
  boolValue,
  readConfig,
  splitShellArgs,
  validateConfig
};
