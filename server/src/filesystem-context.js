'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

let root = '/';

function configureFilesystem(config) {
  root = config.hostMode ? '/proc/1/root' : '/';
}

// Resolve absolute symlinks inside the host root, rather than the container root.
async function physicalPath(value, followFinal = true, filesystemRoot = root) {
  if (filesystemRoot === '/') return value;
  let pending = path.posix.normalize(value).split('/').filter(Boolean);
  let resolved = [];
  let links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (part === '.') continue;
    if (part === '..') { resolved.pop(); continue; }
    const candidate = `${filesystemRoot}/${[...resolved, part].join('/')}`;
    let stat;
    try { stat = await fs.lstat(candidate); } catch (error) {
      if (error.code !== 'ENOENT' || pending.length) throw error;
      resolved.push(part);
      break;
    }
    if (stat.isSymbolicLink() && (followFinal || pending.length)) {
      if (++links > 40) throw Object.assign(new Error('Too many symbolic links'), { code: 'ELOOP' });
      const target = await fs.readlink(candidate);
      if (target.startsWith('/')) resolved = [];
      pending = [...target.split('/').filter(Boolean), ...pending];
    } else {
      resolved.push(part);
    }
  }
  return `${filesystemRoot}/${resolved.join('/')}`;
}

module.exports = { configureFilesystem, physicalPath };
