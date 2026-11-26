'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { createSpeechApi } = require('../src/voice/speech-api');
const { wakeCommand } = require('../src/voice/wake-command');

test('speech requests opt in to a fixed API and return raw mono PCM', async () => {
  let calls = 0;
  const client = createSpeechApi({ fetchAudio: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/audio/speech');
    assert.equal(options.headers.Authorization, 'Bearer mock-key');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.input, 'Hello from Kaashify.');
    assert.equal(body.response_format, 'pcm');
    return new Response(Uint8Array.of(1, 0, 2, 0));
  } });
  assert.match((await client.synthesize('Hello from Kaashify.')).error, /Add an OpenAI key/);
  assert.equal(calls, 0);
  const audio = await client.synthesize('Hello from Kaashify.', 'mock-key');
  assert.equal(audio.sampleRate, 24000);
  assert.deepEqual([...new Int16Array(audio.pcm)], [1, 2]);
  assert.equal(calls, 1);
});

test('stopped requests discard late audio, and credentials stay out of errors', async () => {
  let respond;
  const client = createSpeechApi({ fetchAudio: () => new Promise(resolve => { respond = resolve; }) });
  const old = client.synthesize('Interrupted', 'mock-key');
  client.stop();
  respond(new Response(Uint8Array.of(1, 0)));
  assert.equal(await old, null);

  const request = client.synthesize('New reply', 'mock-key');
  respond(new Response('mock-key', { status: 401 }));
  assert.deepEqual(await request, { error: 'Check your OpenAI key and its speech permissions.' });
});

test('only a command after the wake phrase at the beginning is accepted', () => {
  assert.equal(wakeCommand('Hey, Kaashify, open Notepad and type a reminder.'), 'open Notepad and type a reminder.');
  assert.equal(wakeCommand('Okay Kaashify, draft an email.'), 'draft an email.');
  for (const ambient of ['Open Notepad.', 'I said hey Kaashify, open Notepad', 'Hey Kaashify.', 'Hey Kaashify ...', 'Hey KaashifyBot, open Notepad']) {
    assert.equal(wakeCommand(ambient), '', ambient);
  }
});

test('the armed microphone ignores ordinary speech and closes before passing a command to Hands', () => {
  const main = readFileSync(require.resolve('../index'), 'utf8');
  const joinFinal = main.slice(main.indexOf('function joinFinal('), main.indexOf('function routeHeldText('));
  const events = [];
  const ptt = { held: true, wake: true };
  const state = {
    ptt,
    wakeCommand,
    heardBack: () => false,
    pttStop: (reason) => { events.push(reason); ptt.wake = false; ptt.held = false; },
    routeUtterance: (...args) => events.push(args),
  };
  vm.runInNewContext(joinFinal + '\njoinFinal("Open Notepad", { seg: 7 });', state);
  assert.deepEqual(events, []);
  assert.equal(ptt.held, true);
  vm.runInNewContext('joinFinal("Hey Kaashify, open Notepad", { seg: 8, heardAt: 10 });', state);
  assert.equal(ptt.held, false);
  assert.deepEqual(events, ['wake-command', ['open Notepad', 'wake', 10, 8]]);
});

test('a failed API reply falls back to the installed voice', async () => {
  const renderer = readFileSync(require.resolve('../renderer/renderer'), 'utf8');
  const speech = renderer.slice(renderer.indexOf('  let companionVoiceEnabled ='), renderer.indexOf('  async function runMode('));
  const requests = [];
  const notices = [];
  const played = [];
  const state = {
    settings: { apiSpeech: true },
    pttHeld: false,
    plainify: text => text,
    kaashify: {
      on: () => {},
      voiceSay: async (text, cloud) => {
        requests.push([text, cloud]);
        return cloud ? { error: 'OpenAI voice is unavailable.' } : { pcm: new ArrayBuffer(2), sampleRate: 24000 };
      },
    },
    showStatus: message => notices.push(message),
    speechSynthesis: { cancel: () => {} },
  };
  state.played = played;
  vm.runInNewContext(speech + `
    ownVoice = { ready: true };
    playPcm = (audio) => played.push(audio.sampleRate);
    say('Notepad is open.');
  `, state);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [['Notepad is open.', true], ['Notepad is open.', false]]);
  assert.deepEqual(notices, ['OpenAI voice is unavailable.']);
  assert.deepEqual(played, [24000]);
});
