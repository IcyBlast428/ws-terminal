'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sanitizedEnvironment } = require('./env-file');
const { physicalPath } = require('./filesystem-context');

let ptyModule = null;

function getPty() {
  if (!ptyModule) {
    ptyModule = require('node-pty');
  }
  return ptyModule;
}

function clamp(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseClientMessage(raw, maxBytes) {
  if (!raw || raw.length > maxBytes) {
    return { error: 'input too large' };
  }
  try {
    const message = JSON.parse(raw.toString());
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return null;
    }
    return message;
  } catch {
    return null;
  }
}

function resolveCwd(cwd) {
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) {
      return cwd;
    }
  } catch {
    // Fall back to the service user's home directory.
  }
  return os.homedir() || process.cwd();
}

function normalizeDirectoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) {
    return null;
  }
  if (!path.posix.isAbsolute(value)) {
    return null;
  }
  return path.posix.normalize(value);
}

function formatDirectoryEntries(directoryPath, dirents, limit, showHidden = false, options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const offset = Number(options.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || query.length > 255) throw Object.assign(new Error('Invalid directory page'), { code: 'EINVAL' });
  const entries = dirents.filter((entry) => (showHidden || !entry.name.startsWith('.')) && (!query || entry.name.toLowerCase().includes(query))).map((entry) => ({
    name: entry.name,
    path: path.posix.join(directoryPath, entry.name),
    type: entry.isDirectory()
      ? 'directory'
      : entry.isFile()
        ? 'file'
        : entry.isSymbolicLink()
          ? 'symlink'
          : 'other'
  }));
  entries.sort((left, right) => {
    if (left.type === 'directory' && right.type !== 'directory') {
      return -1;
    }
    if (left.type !== 'directory' && right.type === 'directory') {
      return 1;
    }
    return left.name.localeCompare(right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  });
  const revision = crypto.createHash('sha256').update(JSON.stringify([directoryPath, showHidden, query, entries.map(entry => [entry.name, entry.type])])).digest('hex');
  if (options.revision && options.revision !== revision) throw Object.assign(new Error('Directory changed; refresh before loading more'), { code: 'ESTALE' });
  return {
    entries: entries.slice(offset, offset + limit),
    truncated: entries.length > offset + limit,
    nextOffset: offset + limit < entries.length ? offset + limit : null,
    total: entries.length, offset, query, revision
  };
}

async function listDirectory(value, limit, showHidden = false, options = {}) {
  const directoryPath = normalizeDirectoryPath(value);
  if (!directoryPath) {
    const error = new Error('Invalid directory path');
    error.code = 'EINVAL';
    throw error;
  }
  const dirents = await fs.promises.readdir(await physicalPath(directoryPath), { withFileTypes: true });
  const formatted = formatDirectoryEntries(directoryPath, dirents, limit, showHidden, options);
  const files = formatted.entries.filter((entry) => entry.type === 'file');
  for (let index = 0; index < files.length; index += 16) {
    const batch = files.slice(index, index + 16);
    await Promise.all(batch.map(async (entry) => {
      try {
        const stat = await fs.promises.stat(await physicalPath(entry.path));
        entry.size = stat.size;
      } catch {
        entry.size = null;
      }
    }));
  }
  return {
    path: directoryPath,
    ...formatted
  };
}

async function readTextFile(value, maxBytes) {
  const filePath = normalizeDirectoryPath(value);
  if (!filePath) {
    const error = new Error('Invalid file path');
    error.code = 'EINVAL';
    throw error;
  }

  const diskPath = await physicalPath(filePath);
  const stat = await fs.promises.stat(diskPath);
  if (!stat.isFile()) {
    const error = new Error('Not a regular file');
    error.code = 'EISDIR';
    throw error;
  }
  if (stat.size > maxBytes) {
    const error = new Error('File is too large');
    error.code = 'EFBIG';
    throw error;
  }

  const chunks = [];
  let bytes = 0;
  const stream = fs.createReadStream(diskPath, { highWaterMark: 65536 });
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      stream.destroy();
      const error = new Error('File is too large');
      error.code = 'EFBIG';
      throw error;
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks, bytes);
  if (buffer.includes(0)) {
    const error = new Error('Binary file');
    error.code = 'EISBINARY';
    throw error;
  }
  const content = buffer.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(buffer)) {
    const error = new Error('File is not valid UTF-8');
    error.code = 'EILSEQ';
    throw error;
  }
  return {
    path: filePath,
    content,
    size: bytes,
    modifiedAt: stat.mtime.toISOString(),
    version: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

function validateEntryName(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    const error = new Error('Invalid entry name');
    error.code = 'EINVAL';
    throw error;
  }
  return value;
}

function childPath(parentValue, nameValue) {
  const parentPath = normalizeDirectoryPath(parentValue);
  if (!parentPath) {
    const error = new Error('Invalid parent path');
    error.code = 'EINVAL';
    throw error;
  }
  const name = validateEntryName(nameValue);
  return path.posix.join(parentPath, name);
}

async function writeTextFile(value, content, expectedVersion, maxBytes, beforeWrite = null) {
  const filePath = normalizeDirectoryPath(value);
  if (!filePath || typeof content !== 'string' || typeof expectedVersion !== 'string') {
    const error = new Error('Invalid file save request');
    error.code = 'EINVAL';
    throw error;
  }
  const contentBuffer = Buffer.from(content, 'utf8');
  if (contentBuffer.length > maxBytes) {
    const error = new Error('File is too large');
    error.code = 'EFBIG';
    throw error;
  }

  const handle = await fs.promises.open(await physicalPath(filePath), 'r+');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      const error = new Error('Not a regular file');
      error.code = 'EISDIR';
      throw error;
    }
    if (stat.size > maxBytes) {
      const error = new Error('File is too large');
      error.code = 'EFBIG';
      throw error;
    }
    const current = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < current.length) {
      const { bytesRead } = await handle.read(current, offset, current.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    const currentBuffer = offset === current.length ? current : current.subarray(0, offset);
    const currentVersion = crypto.createHash('sha256').update(currentBuffer).digest('hex');
    if (currentVersion !== expectedVersion) {
      const error = new Error('File changed on disk');
      error.code = 'ESTALE';
      throw error;
    }
    if (beforeWrite) await beforeWrite(filePath, currentBuffer);
    let written = 0;
    while (written < contentBuffer.length) {
      const result = await handle.write(contentBuffer, written, contentBuffer.length - written, written);
      if (!result.bytesWritten) throw new Error('File write stalled');
      written += result.bytesWritten;
    }
    await handle.truncate(contentBuffer.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return readTextFile(filePath, maxBytes);
}

async function createEntry(parentValue, nameValue, entryType) {
  const entryPath = childPath(parentValue, nameValue);
  if (entryType === 'file') {
    const handle = await fs.promises.open(await physicalPath(entryPath), 'wx', 0o600);
    await handle.close();
  } else if (entryType === 'directory') {
    await fs.promises.mkdir(await physicalPath(entryPath), { mode: 0o700 });
  } else {
    const error = new Error('Invalid entry type');
    error.code = 'EINVAL';
    throw error;
  }
  return { operation: 'create', path: entryPath, entryType };
}

async function renameEntry(value, nameValue) {
  const sourcePath = normalizeDirectoryPath(value);
  if (!sourcePath || sourcePath === '/') {
    const error = new Error('Invalid source path');
    error.code = 'EINVAL';
    throw error;
  }
  const destinationPath = childPath(path.posix.dirname(sourcePath), nameValue);
  if (destinationPath === sourcePath) {
    return { operation: 'rename', path: sourcePath, newPath: destinationPath };
  }
  try {
    await fs.promises.lstat(await physicalPath(destinationPath, false));
    const error = new Error('Destination already exists');
    error.code = 'EEXIST';
    throw error;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  await fs.promises.rename(await physicalPath(sourcePath, false), await physicalPath(destinationPath, false));
  return { operation: 'rename', path: sourcePath, newPath: destinationPath };
}

async function deleteEntry(value) {
  const entryPath = normalizeDirectoryPath(value);
  if (!entryPath || entryPath === '/') {
    const error = new Error('Invalid entry path');
    error.code = 'EINVAL';
    throw error;
  }
  const diskPath = await physicalPath(entryPath, false);
  const stat = await fs.promises.lstat(diskPath);
  if (stat.isDirectory()) {
    await fs.promises.rmdir(diskPath);
    return { operation: 'delete', path: entryPath, entryType: 'directory' };
  }
  await fs.promises.unlink(diskPath);
  return { operation: 'delete', path: entryPath, entryType: 'file' };
}

async function readProcessCwd(pid, fallback) {
  if (process.platform !== 'linux' || !Number.isInteger(pid)) {
    return fallback;
  }
  try {
    const cwd = await fs.promises.readlink(`/proc/${pid}/cwd`);
    return normalizeDirectoryPath(cwd) || fallback;
  } catch {
    return fallback;
  }
}

function directoryErrorMessage(error) {
  if (error?.code === 'ESTALE' && error.message.startsWith('Directory changed')) return '目录内容已变化，请刷新后重新加载';
  if (error && error.code === 'EACCES') {
    return 'Permission denied';
  }
  if (error && error.code === 'ENOENT') {
    return 'Directory not found';
  }
  if (error && error.code === 'ENOTDIR') {
    return 'Not a directory';
  }
  if (error && error.code === 'EISDIR') {
    return 'Not a regular text file';
  }
  if (error && error.code === 'EFBIG') {
    return 'File is too large to preview';
  }
  if (error && (error.code === 'EISBINARY' || error.code === 'EILSEQ')) {
    return 'File is not UTF-8 text';
  }
  if (error && error.code === 'ESTALE') {
    return 'File changed on disk; reload before saving';
  }
  if (error && error.code === 'EEXIST') {
    return 'A file or directory with that name already exists';
  }
  if (error && error.code === 'ENOTEMPTY') {
    return 'Directory is not empty';
  }
  if (error && error.code === 'EROFS') {
    return 'File system is read-only';
  }
  if (error && error.code === 'ENOSPC') {
    return 'No space left on device';
  }
  if (error && error.code === 'EINVAL') {
    return 'Invalid file or directory name';
  }
  return 'File operation failed';
}

function terminateProcessGroup(term) {
  if (process.platform !== 'win32' && Number.isInteger(term.pid)) {
    try {
      process.kill(-term.pid, 'SIGHUP');
      return;
    } catch {
      // Fall back to node-pty's direct child termination.
    }
  }
  try {
    term.kill('SIGHUP');
  } catch {
    // The PTY may already have exited.
  }
}

class TerminalManager {
  constructor(config, logger, fileService = null) {
    this.config = config;
    this.logger = logger;
    this.sessions = new Map();
    this.fileService = fileService;
  }

  size() {
    return this.sessions.size;
  }

  canCreateSession() {
    return this.size() < this.config.maxSessions;
  }

  createSession(ws, requestUrl, req, remoteAddress, authSessionId = null, startCwd = null) {
    const id = crypto.randomUUID();
    const cols = clamp(requestUrl.searchParams.get('cols'), this.config.defaultCols, 20, 500);
    const rows = clamp(requestUrl.searchParams.get('rows'), this.config.defaultRows, 5, 200);
    const requestedCwd = startCwd || this.config.cwd;
    if (startCwd && !this.config.hostMode && !fs.statSync(startCwd).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
    const cwd = this.config.hostMode ? requestedCwd : resolveCwd(requestedCwd);
    const startedAt = new Date();
    let closed = false;
    let idleTimer = null;
    let lifetimeTimer = null;
    let drainTimer = null;
    let outputPaused = false;
    let outputSequence = 0;
    let unacknowledgedBytes = 0;
    let currentCwd = cwd;
    let cwdSyncTimer = null;
    let cwdSyncInFlight = false;
    let cwdSyncPending = false;
    let directoryRequestsInFlight = 0;
    let fileRequestsInFlight = 0;
    let disconnectTimer = null;
    const replay = [];
    let replayBytes = 0;
    const pendingAcknowledgements = new Map();

    const shell = this.config.hostMode ? '/usr/bin/nsenter' : this.config.shell;
    const shellArgs = this.config.hostMode
      ? ['--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--no-fork', '--root', `--wd=/proc/1/root${requestedCwd}`, '--', this.config.shell, ...this.config.shellArgs]
      : this.config.shellArgs;
    const term = getPty().spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.config.hostMode ? '/' : cwd,
      env: {
        ...sanitizedEnvironment(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        WS_TERMINAL_SESSION: id
      }
    });

    const session = { id, term, ws, startedAt, remoteAddress, authSessionId, close: null, attached: true, cwd };
    this.sessions.set(id, session);
    this.logger.log('terminal.connected', {
      sessionId: id,
      remoteAddress,
      pid: term.pid
    });

    const send = (message) => {
      if (!ws || ws.readyState !== 1) {
        return false;
      }
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch (err) {
        this.logger.error('terminal.send_failed', err, { sessionId: id });
        return false;
      }
    };

    const stopOutputBackpressure = (resume = true) => {
      if (drainTimer) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
      if (resume && outputPaused && typeof term.resume === 'function') {
        outputPaused = false;
        term.resume();
      } else if (!resume) {
        outputPaused = false;
      }
    };

    const syncCwd = async (force = false) => {
      if (closed) {
        return;
      }
      if (cwdSyncInFlight) {
        cwdSyncPending = true;
        return;
      }
      cwdSyncInFlight = true;
      const nextCwd = await readProcessCwd(term.pid, currentCwd);
      cwdSyncInFlight = false;
      if (!closed && (force || nextCwd !== currentCwd)) {
        currentCwd = nextCwd;
        session.cwd = currentCwd;
        send({ type: 'cwd', path: currentCwd });
      }
      if (cwdSyncPending) {
        cwdSyncPending = false;
        scheduleCwdSync(0);
      }
    };

    const scheduleCwdSync = (delay = 80) => {
      clearTimeout(cwdSyncTimer);
      cwdSyncTimer = setTimeout(() => syncCwd(), delay);
      cwdSyncTimer.unref?.();
    };

    const applyOutputBackpressure = () => {
      if (
        outputPaused ||
        !ws || ws.readyState !== 1 ||
        (ws.bufferedAmount < this.config.wsHighWaterBytes && unacknowledgedBytes < this.config.wsHighWaterBytes) ||
        typeof term.pause !== 'function'
      ) {
        return;
      }
      outputPaused = true;
      term.pause();
      drainTimer = setInterval(() => {
        if (closed || ws.readyState !== 1) {
          stopOutputBackpressure();
          return;
        }
        if (ws.bufferedAmount <= this.config.wsLowWaterBytes && unacknowledgedBytes <= this.config.wsLowWaterBytes) {
          stopOutputBackpressure();
        }
      }, 50);
      drainTimer.unref?.();
    };

    const closeSession = (reason = 'closed') => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(lifetimeTimer);
      clearTimeout(cwdSyncTimer);
      clearTimeout(disconnectTimer);
      stopOutputBackpressure(false);
      pendingAcknowledgements.clear();
      unacknowledgedBytes = 0;
      this.sessions.delete(id);
      terminateProcessGroup(term);
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
        try {
          ws.close(1000, reason.slice(0, 123));
        } catch {
          ws.terminate?.();
        }
      }
      this.logger.log('terminal.disconnected', {
        sessionId: id,
        remoteAddress,
        reason,
        durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000)
      });
    };
    session.close = closeSession;

    const refreshIdleTimer = () => {
      clearTimeout(idleTimer);
      session.idleExpiresAt = Date.now() + this.config.idleTimeoutMs;
      idleTimer = setTimeout(() => {
        send({ type: 'system', data: '\r\n[ws-terminal] idle timeout, closing session.\r\n' });
        closeSession('idle timeout');
      }, this.config.idleTimeoutMs);
      idleTimer.unref?.();
    };

    lifetimeTimer = setTimeout(() => {
      send({ type: 'system', data: '\r\n[ws-terminal] maximum session duration reached.\r\n' });
      closeSession('maximum duration');
    }, this.config.maxSessionDurationMs);
    lifetimeTimer.unref?.();

    term.onData((data) => {
      const sequence = ++outputSequence;
      const bytes = Buffer.byteLength(data, 'utf8');
      replay.push({ type: 'output', data, sequence });
      replayBytes += bytes;
      while (replayBytes > this.config.replayBytes && replay.length > 1) replayBytes -= Buffer.byteLength(replay.shift().data);
      pendingAcknowledgements.set(sequence, bytes);
      unacknowledgedBytes += bytes;
      if (!send({ type: 'output', data, sequence })) {
        pendingAcknowledgements.delete(sequence);
        unacknowledgedBytes -= bytes;
      }
      applyOutputBackpressure();
      scheduleCwdSync();
    });

    term.onExit(({ exitCode, signal }) => {
      send({ type: 'exit', code: exitCode, signal });
      this.logger.log('terminal.process_exit', { sessionId: id, exitCode, signal });
      closeSession('process exited');
    });

    const onMessage = (raw) => {
      const message = parseClientMessage(raw, this.config.maxClientMessageBytes);
      if (!message) {
        return;
      }
      if (message.error) {
        closeSession(message.error);
        return;
      }

      if (message.type === 'close') {
        closeSession('client closed terminal');
        return;
      }

      if (message.type === 'input' && typeof message.data === 'string') {
        if (Buffer.byteLength(message.data, 'utf8') > this.config.maxInputBytes) {
          closeSession('input too large');
          return;
        }
        refreshIdleTimer();
        try {
          term.write(message.data);
          if (message.data.includes('\r') || message.data.includes('\n')) {
            scheduleCwdSync(120);
          }
        } catch (err) {
          this.logger.error('terminal.write_failed', err, { sessionId: id });
          closeSession('PTY write failed');
        }
        return;
      }

      if (
        message.type === 'fs:list' &&
        typeof message.requestId === 'string' &&
        message.requestId.length > 0 &&
        message.requestId.length <= 64
      ) {
        if (directoryRequestsInFlight >= this.config.maxDirectoryRequests) {
          send({
            type: 'fs:error',
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: 'Too many directory requests'
          });
          return;
        }
        directoryRequestsInFlight += 1;
        listDirectory(message.path, this.config.maxDirectoryEntries).then((result) => {
          send({ type: 'fs:list', requestId: message.requestId, ...result });
        }).catch((error) => {
          send({
            type: 'fs:error',
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: directoryErrorMessage(error)
          });
        }).finally(() => {
          directoryRequestsInFlight = Math.max(0, directoryRequestsInFlight - 1);
        });
        return;
      }

      if (
        message.type === 'fs:read' &&
        typeof message.requestId === 'string' &&
        message.requestId.length > 0 &&
        message.requestId.length <= 64
      ) {
        if (fileRequestsInFlight >= this.config.maxFileRequests) {
          send({
            type: 'fs:error',
            operation: 'read',
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: 'Too many file requests'
          });
          return;
        }
        refreshIdleTimer();
        fileRequestsInFlight += 1;
        readTextFile(message.path, this.config.maxFileBytes).then((result) => {
          send({ type: 'fs:file', requestId: message.requestId, ...result });
        }).catch((error) => {
          send({
            type: 'fs:error',
            operation: 'read',
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: directoryErrorMessage(error)
          });
        }).finally(() => {
          fileRequestsInFlight = Math.max(0, fileRequestsInFlight - 1);
        });
        return;
      }

      if (
        message.type === 'fs:write' &&
        typeof message.requestId === 'string' &&
        message.requestId.length > 0 &&
        message.requestId.length <= 64 &&
        typeof message.content === 'string' &&
        typeof message.expectedVersion === 'string'
      ) {
        if (fileRequestsInFlight >= this.config.maxFileRequests) {
          send({
            type: 'fs:error',
            operation: 'write',
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: 'Too many file requests'
          });
          return;
        }
        refreshIdleTimer();
        fileRequestsInFlight += 1;
        (this.fileService ? this.fileService.write(message.path, message.content, message.expectedVersion)
          : writeTextFile(message.path, message.content, message.expectedVersion, this.config.maxFileBytes)).then((result) => {
          this.logger.log('filesystem.file_saved', { sessionId: id, path: result.path, size: result.size });
          send({ type: 'fs:saved', requestId: message.requestId, ...result });
        }).catch((error) => {
          send({
            type: 'fs:error',
            operation: 'write',
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: directoryErrorMessage(error)
          });
        }).finally(() => {
          fileRequestsInFlight = Math.max(0, fileRequestsInFlight - 1);
        });
        return;
      }

      if (
        message.type === 'fs:mutate' &&
        typeof message.requestId === 'string' &&
        message.requestId.length > 0 &&
        message.requestId.length <= 64
      ) {
        if (fileRequestsInFlight >= this.config.maxFileRequests) {
          send({
            type: 'fs:error',
            operation: message.operation,
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: 'Too many file requests'
          });
          return;
        }
        let operation;
        if (message.operation === 'create-file') {
          operation = () => createEntry(message.path, message.name, 'file');
        } else if (message.operation === 'create-directory') {
          operation = () => createEntry(message.path, message.name, 'directory');
        } else if (message.operation === 'rename') {
          operation = () => renameEntry(message.path, message.name);
        } else if (message.operation === 'delete') {
          operation = () => deleteEntry(message.path);
        } else {
          send({
            type: 'fs:error',
            operation: message.operation,
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: 'Invalid file operation'
          });
          return;
        }
        refreshIdleTimer();
        fileRequestsInFlight += 1;
        Promise.resolve().then(operation).then((result) => {
          this.logger.log('filesystem.mutated', { sessionId: id, ...result });
          send({ type: 'fs:mutated', requestId: message.requestId, ...result });
        }).catch((error) => {
          send({
            type: 'fs:error',
            operation: message.operation,
            requestId: message.requestId,
            path: typeof message.path === 'string' ? message.path : '',
            error: directoryErrorMessage(error)
          });
        }).finally(() => {
          fileRequestsInFlight = Math.max(0, fileRequestsInFlight - 1);
        });
        return;
      }

      if (message.type === 'ack' && Number.isSafeInteger(message.sequence)) {
        for (const [sequence, bytes] of pendingAcknowledgements) {
          if (sequence > message.sequence) {
            break;
          }
          pendingAcknowledgements.delete(sequence);
          unacknowledgedBytes = Math.max(0, unacknowledgedBytes - bytes);
        }
        if (
          outputPaused &&
          ws.bufferedAmount <= this.config.wsLowWaterBytes &&
          unacknowledgedBytes <= this.config.wsLowWaterBytes
        ) {
          stopOutputBackpressure();
        }
        return;
      }

      if (message.type === 'resize') {
        const nextCols = clamp(message.cols, cols, 20, 500);
        const nextRows = clamp(message.rows, rows, 5, 200);
        try {
          term.resize(nextCols, nextRows);
        } catch {
          // Ignore resize races while the PTY is exiting.
        }
      }
    };

    const attach = (socket, after = 0, resumed = false) => {
      if (closed) return false;
      const previous = ws;
      if (resumed && previous && previous !== socket) previous.close(1000, 'session attached elsewhere');
      ws = socket;
      session.ws = socket;
      session.attached = true;
      session.reconnectExpiresAt = null;
      clearTimeout(disconnectTimer);
      pendingAcknowledgements.clear();
      unacknowledgedBytes = 0;
      socket.on('message', raw => { if (ws === socket) onMessage(raw); });
      socket.on('close', () => {
        if (closed || ws !== socket) return;
        ws = null;
        session.ws = null;
        session.attached = false;
        session.reconnectExpiresAt = Math.min(Date.now() + this.config.reconnectGraceMs, startedAt.getTime() + this.config.maxSessionDurationMs, session.idleExpiresAt || Infinity);
        pendingAcknowledgements.clear();
        unacknowledgedBytes = 0;
        stopOutputBackpressure();
        disconnectTimer = setTimeout(() => closeSession('reconnect grace expired'), this.config.reconnectGraceMs);
        disconnectTimer.unref?.();
        this.logger.log('terminal.detached', { sessionId: id, pid: term.pid, graceSeconds: this.config.reconnectGraceMs / 1000 });
      });
      socket.on('error', err => { this.logger.error('terminal.socket_error', err, { sessionId: id }); socket.terminate(); });
      send({ type: 'ready', id, shell: this.config.shell, cwd: currentCwd, startedAt: startedAt.toISOString(), resumed });
      if (resumed) {
        if (replay.length && after < replay[0].sequence - 1) send({ type: 'system', data: '\r\n[ws-terminal] Older disconnected output exceeded the replay limit.\r\n' });
        for (const message of replay) {
          if (message.sequence <= after) continue;
          const bytes = Buffer.byteLength(message.data);
          pendingAcknowledgements.set(message.sequence, bytes);
          unacknowledgedBytes += bytes;
          send(message);
        }
        applyOutputBackpressure();
        this.logger.log('terminal.resumed', { sessionId: id, remoteAddress });
      }
      send({ type: 'cwd', path: currentCwd });
      return true;
    };
    session.attach = attach;
    refreshIdleTimer();
    attach(ws);
    return session;
  }

  ownedSession(id, authSessionId) {
    const session = this.sessions.get(id);
    return session && session.authSessionId === authSessionId ? session : null;
  }

  listSessions(authSessionId) {
    return [...this.sessions.values()].filter(session => session.authSessionId === authSessionId).map(session => ({
      id: session.id, pid: session.term.pid, cwd: session.cwd, attached: session.attached,
      remoteAddress: session.remoteAddress, startedAt: session.startedAt.toISOString(),
      reconnectExpiresAt: session.reconnectExpiresAt ? new Date(session.reconnectExpiresAt).toISOString() : null
    }));
  }

  closeByAuthSession(authSessionId, reason = 'login revoked') {
    if (!authSessionId) {
      return 0;
    }
    let closed = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.authSessionId === authSessionId && typeof session.close === 'function') {
        session.close(reason);
        closed += 1;
      }
    }
    return closed;
  }

  shutdown(reason = 'service shutdown') {
    for (const session of [...this.sessions.values()]) {
      if (typeof session.close === 'function') {
        session.close(reason);
      }
    }
  }
}

module.exports = {
  createEntry,
  deleteEntry,
  directoryErrorMessage,
  formatDirectoryEntries,
  listDirectory,
  normalizeDirectoryPath,
  parseClientMessage,
  readTextFile,
  readProcessCwd,
  renameEntry,
  TerminalManager,
  terminateProcessGroup,
  validateEntryName,
  writeTextFile
};
