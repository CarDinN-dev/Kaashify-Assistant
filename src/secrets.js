const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { replaceProfileFile, canEncrypt } = require('./profile-file');

let secretsDir = null;
const sessionSecrets = new Map();

function init(userDataDir) {
  secretsDir = path.join(userDataDir, 'secrets');
  sessionSecrets.clear();
  fs.mkdirSync(secretsDir, { recursive: true });
}

function isAvailable() {
  return canEncrypt(safeStorage);
}

function secretPath(key, extension) {
  if (typeof key !== 'string' || !/^[\w-]{1,80}$/.test(key)) throw new Error('Invalid secret name');
  return path.join(secretsDir, key + extension);
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function setSecret(key, value) {
  if (!secretsDir) throw new Error('secrets: not initialized');
  const encPath = secretPath(key, '.enc');
  const plainPath = secretPath(key, '.plain');
  if (!isAvailable()) {
    sessionSecrets.set(key, String(value));
    removeFile(plainPath);
    return;
  }
  replaceProfileFile(encPath, safeStorage.encryptString(String(value)));
  sessionSecrets.delete(key);
  removeFile(plainPath);
}

function getSecret(key) {
  if (!secretsDir) return null;
  const encPath = secretPath(key, '.enc');
  const plainPath = secretPath(key, '.plain');
  if (sessionSecrets.has(key)) return sessionSecrets.get(key);
  if (fs.existsSync(encPath)) {
    if (!isAvailable()) return null;
    try { return safeStorage.decryptString(fs.readFileSync(encPath)); } catch { return null; }
  }
  if (fs.existsSync(plainPath)) {
    const value = fs.readFileSync(plainPath, 'utf8');
    setSecret(key, value);
    return value;
  }
  return null;
}

function deleteSecret(key) {
  if (!secretsDir) return;
  sessionSecrets.delete(key);
  for (const ext of ['enc', 'plain']) {
    removeFile(secretPath(key, '.' + ext));
  }
}

function listSecrets() {
  if (!secretsDir || !fs.existsSync(secretsDir)) return [];
  const saved = fs.readdirSync(secretsDir).filter(f => /\.(enc|plain)$/.test(f)).map(f => f.replace(/\.(enc|plain)$/, ''));
  return [...new Set([...saved, ...sessionSecrets.keys()])];
}

module.exports = { init, setSecret, getSecret, deleteSecret, listSecrets, isAvailable };
