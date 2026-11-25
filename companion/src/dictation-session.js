'use strict';

const { focusTakesText, tidy } = require('./dictate');

const MAX_MS = 5 * 60 * 1000;
const FOCUS_MS = 400;
const START = /^(?:(?:kaashify|kashify|cashify)[,.!]?\s+)?start typing[.!?]*$/i;
const STOP = /^(?:kaashify|kashify|cashify)[,.!]?\s+stop typing[.!?]*$/i;

function typingCommand(text) {
  const words = tidy(text);
  if (START.test(words)) return 'start';
  if (STOP.test(words) || /^stop typing[.!?]*$/i.test(words)) return 'stop';
  return null;
}

function createDictationSession({ selfPid, focus, foreground, paste, listener, onState }) {
  let session = null;
  let nextId = 0;
  let deadline;
  let polling;
  let tail = Promise.resolve();

  const sameWindow = (a, b) => Boolean(a && b && a.hwnd === b.hwnd && a.pid === b.pid);
  const isTarget = (f) => f && Number.isSafeInteger(f.hwnd) && f.hwnd > 0 && Number.isSafeInteger(f.pid) && f.pid > 0 && f.pid !== selfPid;
  const current = (s, id) => session === s && s.state === 'active' && s.id === id;
  const canType = (f) => isTarget(f) && !f.error && focusTakesText(f).text === 'yes';

  function closeStream(s) {
    clearTimeout(polling);
    if (s.audio) {
      s.audio.reset();
      s.audio = null;
    }
  }

  function stop(reason = 'stopped') {
    const s = session;
    if (!s) return false;
    session = null;
    clearTimeout(deadline);
    closeStream(s);
    onState({ state: 'idle', id: s.id, reason });
    return true;
  }

  function pause(s, reason) {
    if (session !== s || s.state !== 'active') return;
    s.state = 'paused';
    closeStream(s);
    onState({ state: 'paused', id: s.id, reason });
  }

  function watch(s) {
    const id = s.id;
    polling = setTimeout(async () => {
      const front = await foreground().catch(() => null);
      if (!current(s, id)) return;
      if (sameWindow(front, s.target)) watch(s);
      else pause(s, 'focus');
    }, FOCUS_MS);
  }

  function accept(s, id, input) {
    if (!current(s, id)) return;
    const text = tidy(input);
    if (!text) return;
    if (STOP.test(text)) {
      stop();
      return;
    }
    // Serialize pastes. An utterance that arrives after a pause or stop is stale.
    tail = tail.then(async () => {
      if (!current(s, id)) return;
      const f = await focus().catch(() => null);
      if (!current(s, id)) return;
      if (!sameWindow(f, s.target) || !canType(f)) { pause(s, 'focus'); return; }
      const result = await paste(s.target, (s.wrote ? ' ' : '') + text);
      if (result?.ok && result.how !== 'none') s.wrote = true;
      else if (current(s, id)) pause(s, result?.stopped === 'focus' || result?.refused === 'password' ? 'focus' : 'paste');
    }).catch(() => { if (current(s, id)) pause(s, 'paste'); });
  }

  async function start() {
    if (session && session.state !== 'paused') return false;
    const s = session || { id: 0, target: null, wrote: false, audio: null };
    session = s;
    s.state = 'starting';
    const f = await focus({ starting: true }).catch(() => null);
    if (session !== s) return false;
    if (!canType(f) || (s.target && !sameWindow(f, s.target))) {
      if (s.target) {
        s.state = 'paused';
        onState({ state: 'paused', id: s.id, reason: 'focus' });
      } else stop('no-target');
      return false;
    }

    const id = ++nextId;
    s.id = id;
    try { s.audio = listener((text) => accept(s, id, text)); }
    catch (_) { stop('speech'); return false; }
    if (!s.audio.available) { stop('speech'); return false; }
    if (!s.target) {
      s.target = { hwnd: f.hwnd, pid: f.pid };
      deadline = setTimeout(() => stop('timeout'), MAX_MS);
    }
    s.state = 'active';
    onState({ state: 'active', id });
    watch(s);
    return true;
  }

  function push(id, pcm) {
    if (session?.state === 'active' && session.id === id) session.audio.push(pcm);
  }

  function microphoneFailed(id) {
    if (session?.state === 'active' && session.id === id) stop('microphone');
  }

  return { start, stop, push, microphoneFailed, state: () => session?.state || 'idle' };
}

module.exports = { createDictationSession, typingCommand };
