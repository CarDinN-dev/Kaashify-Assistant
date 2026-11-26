'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { replaceProfileFile } = require('../../../src/profile-file');

const NAME = 'com.kaashify.chrome';
const REGISTRY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + NAME;
const MAX_FRAME = 128 * 1024;
const REQUEST_MS = 4000;
const PAIR_MS = 3 * 60 * 1000;
const EXTENSION_ID = /^[a-p]{32}$/;
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOST = Object.freeze({ ok: false, reason: 'browser-unavailable' });

function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_FRAME) throw new Error('Chrome message too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}

function decode(onValue) {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (!size || size > MAX_FRAME) throw new Error('Invalid Chrome message');
      if (pending.length < size + 4) return;
      const value = JSON.parse(pending.subarray(4, 4 + size).toString('utf8'));
      pending = pending.subarray(4 + size);
      onValue(value);
    }
  };
}

function sameSecret(input, secret) {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) return false;
  return timingSafeEqual(Buffer.from(input, 'hex'), Buffer.from(secret, 'hex'));
}

function createChromeBridge({ extensionId, profileDir, executable, getProfile, saveProfile, onStatus = () => {},
  pipeAddress = id => '\\\\.\\pipe\\kaashify-chrome-' + id,
  register = manifest => promisify(execFile)(process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe',
    ['ADD', REGISTRY, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { windowsHide: true, timeout: 4000 }),
  createServer = net.createServer } = {}) {
  const available = EXTENSION_ID.test(extensionId || '');
  const runtime = path.join(profileDir, 'chrome-bridge.json');
  const manifestPath = path.join(profileDir, 'chrome-native-host.json');
  let server, peer, starting, pairingUntil = 0, enabled = false;
  const sockets = new Set();
  const awaiting = new Map();
  const profile = () => String(getProfile() || '');
  const status = () => ({ available, enabled, connected: !!peer, pairing: !!pairingUntil && pairingUntil > Date.now() });
  const changed = () => onStatus(status());
  const flush = socket => {
    for (const [id, request] of awaiting) {
      if (request.socket === socket) request.done(id, LOST);
    }
  };

  function accept(socket, secret) {
    if (sockets.size >= 5) { socket.destroy(); return; }
    sockets.add(socket);
    let stage = 0;
    const handshake = setTimeout(() => { if (stage !== 2) socket.destroy(); }, 4000);
    handshake.unref?.();
    const read = decode(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid chrome response');
      if (stage === 0) {
        if (!sameSecret(value.token, secret)) throw new Error('Invalid connection');
        stage = 1;
        return;
      }
      if (stage === 1) {
        if (!enabled || value.kind !== 'profile' || !PROFILE_ID.test(value.profile || '')) throw new Error('Invalid profile');
        const paired = profile();
        if (paired !== value.profile) {
          if (paired || !value.focused || Date.now() >= pairingUntil) throw new Error('Profile not paired');
          if (saveProfile(value.profile) === false) throw new Error('Profile could not be saved');
        }
        pairingUntil = 0;
        if (peer) peer.destroy();
        peer = socket;
        stage = 2;
        clearTimeout(handshake);
        changed();
        return;
      }
      if (socket !== peer) return;
      const pending = awaiting.get(value.id);
      if (!pending || pending.socket !== socket) return;
      pending.done(value.id, value.result && typeof value.result.ok === 'boolean' ? value.result : LOST);
    });
    socket.on('data', chunk => { try { read(chunk); } catch { socket.destroy(); } });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(handshake);
      sockets.delete(socket);
      flush(socket);
      if (peer === socket) { peer = null; changed(); }
    });
  }

  async function start() {
    if (!available || !enabled) return false;
    if (starting) return starting;
    if (server) return true;
    starting = (async () => {
      const pipe = pipeAddress(randomBytes(18).toString('hex'));
      const secret = randomBytes(32).toString('hex');
      await fs.access(executable);
      await fs.mkdir(profileDir, { recursive: true });
      const next = createServer(socket => accept(socket, secret));
      await new Promise((resolve, reject) => {
        next.once('error', reject);
        next.listen(pipe, () => { next.removeListener('error', reject); resolve(); });
      });
      next.on('error', () => { void disconnect(); });
      server = next;
      try {
        if (!enabled) { next.close(); server = null; return false; }
        const origin = 'chrome-extension://' + extensionId + '/';
        replaceProfileFile(runtime, JSON.stringify({ pipe, token: secret, origin }));
        replaceProfileFile(manifestPath, JSON.stringify({
          name: NAME, description: 'Kaashify Assistant Chrome connection', path: executable,
          type: 'stdio', allowed_origins: [origin],
        }));
        await register(manifestPath);
        return enabled;
      } catch (error) {
        await disconnect();
        throw error;
      }
    })();
    try { return await starting; } finally { starting = null; }
  }

  async function enable({ pair = false } = {}) {
    if (!available) return false;
    enabled = true;
    if (pair && !profile()) pairingUntil = Date.now() + PAIR_MS;
    try { return await start(); }
    catch { return false; }
    finally { changed(); }
  }

  async function disconnect() {
    enabled = false;
    pairingUntil = 0;
    const current = server;
    server = null;
    const active = peer;
    peer = null;
    if (active) flush(active);
    for (const socket of sockets) socket.destroy();
    if (current) current.close();
    await fs.unlink(runtime).catch(() => {});
    changed();
  }

  function send(message, { signal } = {}) {
    const socket = peer;
    if (!socket || socket.destroyed || signal?.aborted || awaiting.size >= 4) return Promise.resolve(LOST);
    const id = randomBytes(16).toString('hex');
    return new Promise(resolve => {
      let timer;
      function done(key, result) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        awaiting.delete(key);
        resolve(result);
      }
      function abort() {
        cancel(message.task);
        done(id, LOST);
      }
      const deadline = Date.now() + REQUEST_MS - 300;
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, REQUEST_MS);
      timer.unref?.();
      awaiting.set(id, { socket, done });
      try { socket.write(frame({ ...message, id, deadline })); } catch { done(id, LOST); }
    });
  }
  function cancel(task) {
    if (!task || !peer || peer.destroyed) return;
    try { peer.write(frame({ kind: 'cancel', task })); } catch { /* already closed */ }
  }

  return { enable, disconnect, send, cancel, status, listing: () => available ? 'https://chromewebstore.google.com/detail/' + extensionId : '' };
}

module.exports = { createChromeBridge, frame, decode, EXTENSION_ID };
