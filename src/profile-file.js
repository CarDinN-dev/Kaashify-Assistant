'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function replaceProfileFile(file, bytes) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID());
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function canEncrypt(safeStorage) {
  try {
    return !!safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  } catch {
    return false;
  }
}

module.exports = { replaceProfileFile, canEncrypt };
