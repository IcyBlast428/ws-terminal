'use strict';

const fs = require('node:fs');

const SENSITIVE_ENV_NAME = /(TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|API_KEY|PRIVATE_KEY|COOKIE|AUTHORIZATION)/i;

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath, target = process.env) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = stripQuotes(trimmed.slice(separator + 1));
    if (!key || Object.prototype.hasOwnProperty.call(target, key)) {
      continue;
    }
    target[key] = value;
  }

  return true;
}

function sanitizedEnvironment(source = process.env) {
  const result = {};
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('WS_TERMINAL_') || SENSITIVE_ENV_NAME.test(name)) {
      continue;
    }
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

module.exports = {
  loadEnvFile,
  sanitizedEnvironment
};
