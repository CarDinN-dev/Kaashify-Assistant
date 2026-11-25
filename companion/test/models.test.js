'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { isModelProvider, MODEL_SLOTS, modelSettingsPatch, selectModel, NVIDIA_VISION } = require('../src/models');
const { createLLM, NVIDIA_BASE_URL } = require('../src/llm');

const GEMMA = 'google/gemma-4-31b-it';
const imageDataUrl = 'data:image/png;base64,dGVzdA==';
const ask = { system: 'S', turns: [{ role: 'user', text: 'T' }], onToken: () => {} };

test('model settings accept provider IDs and reset blanks without writing arbitrary properties', () => {
  assert.deepEqual(modelSettingsPatch({
    provider: 'nvidia',
    models: { nvidia: { fast: ' ' + GEMMA + ' ', smart: '', vision: '', ignored: 'x' }, unknown: { fast: 'x' } },
  }), { provider: 'nvidia', models: { nvidia: { fast: GEMMA, smart: NVIDIA_VISION, vision: '' } } });
  assert.deepEqual(modelSettingsPatch({ provider: 'constructor', models: { openai: ['not a model map'] } }), {});
  assert.throws(() => modelSettingsPatch({ models: { openai: { fast: 'model\ninvalid' } } }), /valid model ID/);
});

test('a text override and a screen override reach different NVIDIA model IDs on the standard endpoint', async (t) => {
  const requests = [];
  function FakeOpenAI(options) {
    this.chat = { completions: { create: async (body) => {
      requests.push({ options, body });
      return (async function* () { yield { choices: [{ delta: { content: 'answer' } }] }; })();
    } } };
  }
  const load = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) { return name === 'openai' ? FakeOpenAI : load.call(this, name, ...args); });
  const nvidia = { provider: 'nvidia', apiKeys: { nvidia: 'test-key' }, models: { nvidia: { fast: 'nvidia/text-model', vision: GEMMA } } };
  const llm = createLLM(nvidia, { ownKey: true });
  assert.equal(await llm.complete(ask), 'answer');
  await llm.stream({ ...ask, imageDataUrl, model: 'nvidia/text-model' });
  await createLLM({ ...nvidia, models: { nvidia: { fast: GEMMA } } }, { ownKey: true }).complete({ ...ask, imageDataUrl });

  assert.deepEqual(requests.map((r) => r.body.model), ['nvidia/text-model', GEMMA, NVIDIA_VISION]);
  assert.equal(requests[0].body.messages.at(-1).content, 'T');
  assert.equal(requests[1].body.messages.at(-1).content[1].image_url.url, imageDataUrl);
  assert.equal(requests[1].options.baseURL, NVIDIA_BASE_URL);
  assert.equal(requests[1].body.reasoning_effort, undefined);
  assert.equal(requests[1].body.max_tokens, 4096);
  assert.equal(requests[2].body.reasoning_effort, 'none');

  await createLLM({ provider: 'openai', apiKeys: { openai: 'test-key' }, models: { openai: { fast: 'gpt-5-mini' } } }, { ownKey: true }).complete(ask);
  assert.equal(requests[3].body.model, 'gpt-5-mini');
  assert.equal(requests[3].body.max_completion_tokens, 512);
  assert.equal(requests[3].body.max_tokens, undefined);
  assert.equal(requests[3].body.messages[0].role, 'developer');
});

test('Gemma and Gemini use the selected prompt and output format on Google', async (t) => {
  const requests = [];
  class FakeGenAI {
    models = { generateContent: async (req) => { requests.push(req); return { text: 'OK' }; } };
  }
  const load = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    return name === '@google/genai' ? { GoogleGenAI: FakeGenAI } : load.call(this, name, ...args);
  });
  const settings = { provider: 'gemini', apiKeys: { gemini: 'test-key' }, models: { gemini: { fast: 'gemma-3-27b-it', vision: 'gemma-4-31b-it' } } };
  const llm = createLLM(settings, { ownKey: true });
  await llm.complete({ ...ask, json: true });
  await llm.complete({ ...ask, imageDataUrl, json: true });
  await createLLM({ ...settings, models: {} }, { ownKey: true }).complete({ ...ask, imageDataUrl, json: true });
  assert.equal(requests[0].model, 'gemma-3-27b-it');
  assert.equal(requests[0].config.systemInstruction, undefined);
  assert.deepEqual(requests[0].contents[0].parts.map((part) => part.text), ['S', 'T']);
  assert.equal(requests[1].model, 'gemma-4-31b-it');
  assert.equal(requests[1].config.systemInstruction, 'S');
  assert.equal(requests[1].config.responseMimeType, undefined);
  assert.equal(requests[1].contents[0].parts.at(-1).inlineData.mimeType, 'image/png');
  assert.equal(requests[2].config.responseMimeType, 'application/json');
  assert.equal(requests[2].model, selectModel({}, 'gemini', 'fast'));
});

test('the dashboard checks draft models with a generated image and never includes a stored key in its result', async () => {
  const source = readFileSync(path.join(__dirname, '../../src/main-companion.js'), 'utf8');
  const helpers = source.slice(source.indexOf('function scrub('), source.indexOf('async function testKeys('));
  const modelCheck = source.slice(source.indexOf('const MODEL_TEST_IMAGE'), source.indexOf('// Get started, step 1.'));
  const requests = [];
  let reply = 'Magenta.';
  const ctx = {
    AbortSignal, MODEL_SLOTS, isModelProvider, modelSettingsPatch,
    store: { getSettings: () => ({ provider: 'gemini', apiKeys: { nvidia: 'test-key' }, models: { nvidia: { fast: 'saved/model' } } }) },
    createLLM: (settings, opts) => ({
      ready: !!settings.apiKeys[settings.provider],
      complete: async (params) => {
        requests.push({ settings, opts, params });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    }),
  };
  const testModel = vm.runInNewContext(helpers + modelCheck + '\ntestModel;', ctx);
  const result = await testModel({ provider: 'nvidia', slot: 'vision', modelId: GEMMA, smart: true });
  assert.equal(result.ok, true);
  assert.equal(requests[0].settings.models.nvidia.vision, GEMMA);
  assert.equal(requests[0].settings.provider, 'nvidia');
  assert.equal(requests[0].opts.ownKey, true);
  const png = Buffer.from(requests[0].params.imageDataUrl.split(',')[1], 'base64');
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);

  reply = new Error('Rejected credential test-key');
  const bad = await testModel({ provider: 'nvidia', slot: 'fast', modelId: 'draft/model' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Rejected credential [key]');
  assert.equal(requests[1].params.imageDataUrl, undefined);
  assert.equal(requests[1].settings.models.nvidia.fast, 'draft/model');
  assert.equal((await testModel({ provider: 'openai', slot: 'smart', modelId: '' })).ok, false);
  assert.equal(requests.length, 2);
});
