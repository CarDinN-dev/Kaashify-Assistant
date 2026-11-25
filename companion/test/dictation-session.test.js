'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDictationSession, typingCommand } = require('../src/dictation-session');
const { createListener } = require('../src/reflex/listen');

const NOTEPAD = { hwnd: 50, pid: 100, cls: 'Notepad', type: 'Edit', caret: true };
const OTHER = { hwnd: 51, pid: 101, type: 'Edit', caret: true };
const yieldOnce = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function rig(t, overrides = {}) {
  const states = [], pastes = [], streams = [];
  let front = NOTEPAD;
  const session = createDictationSession({
    selfPid: 42,
    focus: async () => front,
    foreground: async () => front,
    paste: async (target, text) => { pastes.push({ target, text }); return { ok: true, how: 'paste' }; },
    listener: (onFinal) => {
      const stream = { onFinal, available: true, reset: t.mock.fn(), push: t.mock.fn() };
      streams.push(stream);
      return stream;
    },
    onState: (state) => states.push(state),
    ...overrides,
  });
  t.after(() => session.stop());
  return { session, pastes, streams, states, switchTo: (f) => { front = f; }, currentId: () => states.at(-1).id };
}

test('dictation controls require standalone words', () => {
  assert.equal(typingCommand('Kaashify, start typing.'), 'start');
  assert.equal(typingCommand('Stop typing'), 'stop');
  assert.equal(typingCommand('Kaashify, stop typing!'), 'stop');
  for (const message of ['Type', 'I said start typing.', 'Kaashify, stop typing that line.']) {
    assert.equal(typingCommand(message), null, message);
  }
});

test('final speech is pasted with punctuation and spaces until the addressed stop phrase', async (t) => {
  const r = rig(t);
  assert.equal(await r.session.start(), true);
  const audio = r.streams[0];
  const pcm = Buffer.alloc(3200);
  r.session.push(r.currentId(), pcm);
  assert.equal(audio.push.mock.calls[0].arguments[0], pcm);
  audio.onFinal('Open Calculator to check it.');
  audio.onFinal('Stop typing is the name of the button.');
  audio.onFinal('Stop typing.');
  await yieldOnce();
  assert.deepEqual(r.pastes, [
    { target: { hwnd: 50, pid: 100 }, text: 'Open Calculator to check it.' },
    { target: { hwnd: 50, pid: 100 }, text: ' Stop typing is the name of the button.' },
    { target: { hwnd: 50, pid: 100 }, text: ' Stop typing.' },
  ]);
  audio.onFinal('Cashify, stop typing!');
  audio.onFinal('Discard stale audio.');
  r.session.push(r.currentId(), pcm);
  await yieldOnce();
  assert.equal(audio.reset.mock.callCount(), 1);
  assert.equal(audio.push.mock.callCount(), 1);
  assert.deepEqual(r.states.map(({ state, reason }) => [state, reason]), [['active', undefined], ['idle', 'stopped']]);
  assert.equal(r.pastes.length, 3);
});

test('switching windows closes the stream and explicit resume keeps the original window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig(t);
  await r.session.start();
  const oldId = r.currentId();
  r.switchTo(OTHER);
  t.mock.timers.tick(400);
  await yieldOnce();
  assert.equal(r.session.state(), 'paused');
  assert.equal(r.streams[0].reset.mock.callCount(), 1);
  assert.equal(await r.session.start(), false);
  r.switchTo(NOTEPAD);
  assert.equal(await r.session.start(), true);
  assert.notEqual(r.currentId(), oldId);
  r.streams[0].onFinal('Stale words.');
  r.session.microphoneFailed(oldId);
  r.streams[1].onFinal('Back in Notepad.');
  await yieldOnce();
  assert.deepEqual(r.pastes.map((p) => p.text), ['Back in Notepad.']);
  t.mock.timers.tick(5 * 60 * 1000);
  assert.equal(r.states.at(-1).reason, 'timeout');
  assert.equal(r.streams[1].reset.mock.callCount(), 1);
});

test('a cancelled target check and queued text cannot paste after Escape', async (t) => {
  const pending = deferred();
  let checks = 0;
  const r = rig(t, { focus: () => ++checks === 1 ? Promise.resolve(NOTEPAD) : pending.promise });
  await r.session.start();
  r.streams[0].onFinal('This never pastes.');
  await yieldOnce();
  assert.equal(checks, 2);
  assert.equal(r.session.stop(), true);
  pending.resolve(NOTEPAD);
  await yieldOnce();
  assert.deepEqual(r.pastes, []);
  assert.equal(r.session.state(), 'idle');
});

test('window changes and password fields are checked again before every paste', async (t) => {
  for (const front of [OTHER, { ...NOTEPAD, password: true }]) {
    const r = rig(t);
    await r.session.start();
    r.switchTo(front);
    r.streams[0].onFinal('This never pastes.');
    await yieldOnce();
    assert.equal(r.states.at(-1).reason, 'focus');
    assert.deepEqual(r.pastes, []);
    r.session.stop();
  }
});

test('an old failed paste cannot pause a resumed stream and mic failure closes the live stream', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const done = deferred();
  const paste = t.mock.fn(() => done.promise);
  const r = rig(t, { paste });
  await r.session.start();
  r.streams[0].onFinal('First line.');
  await yieldOnce();
  assert.equal(paste.mock.callCount(), 1);
  r.switchTo(OTHER);
  t.mock.timers.tick(400);
  await yieldOnce();
  assert.equal(r.session.state(), 'paused');
  r.switchTo(NOTEPAD);
  await r.session.start();
  done.resolve({ ok: false, stopped: 'focus' });
  await yieldOnce();
  assert.equal(r.session.state(), 'active');
  r.session.microphoneFailed(r.currentId());
  assert.equal(r.states.at(-1).reason, 'microphone');
  assert.equal(r.streams[1].reset.mock.callCount(), 1);
});

test('no audio starts in an uneditable field or in Kaashify', async (t) => {
  const r = rig(t);
  for (const front of [{ ...NOTEPAD, password: true }, { ...NOTEPAD, pid: 42 }, { ...NOTEPAD, caret: false, type: 'Button' }, null]) {
    r.switchTo(front);
    assert.equal(await r.session.start(), false);
    assert.equal(r.states.at(-1).reason, 'no-target');
  }
  assert.deepEqual(r.streams, []);
});

test('audio reaches the existing local listener, which sends only finalized speech to the pinned target', async (t) => {
  const words = ['Open Calculator to check it.', 'Kaashify, stop typing.'];
  const r = rig(t, { listener: (onFinal) => createListener({ onFinal, transcribe: async () => words.shift() }) });
  const speech = Buffer.alloc(500 * 32);
  for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(1200, offset);
  const pause = Buffer.alloc(450 * 32);
  await r.session.start();
  for (let i = 0; i < 2; i++) {
    r.session.push(r.currentId(), speech);
    r.session.push(r.currentId(), pause);
    await yieldOnce();
  }
  assert.deepEqual(r.pastes.map((p) => p.text), ['Open Calculator to check it.']);
  assert.equal(r.session.state(), 'idle');
});
