'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { createChromeBridge, frame, decode } = require('../src/chrome/bridge');
const { makeBrowserActions, willUseChrome } = require('../src/chrome/actions');
const { compoundRequest } = require('../src/hands/compound');
const { HandsAgent } = require('../src/hands/agent');
const { createPending } = require('../src/hands/consent');

test('Chrome frames handle fragmentation and reject unbounded input', () => {
  const values = [];
  const receive = decode(value => values.push(value));
  const bytes = Buffer.concat([frame({ test: 1 }), frame({ test: 2 })]);
  receive(bytes.subarray(0, 3));
  receive(bytes.subarray(3, 9));
  receive(bytes.subarray(9));
  assert.deepEqual(values, [{ test: 1 }, { test: 2 }]);
  assert.throws(() => receive(Buffer.from([0, 0, 255, 0])), /Invalid Chrome message/);
});

test('local host authenticates, pairs one foreground profile, and drops requests at disconnect', { skip: process.platform === 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ks-chrome-'));
  const executable = path.join(dir, 'host.exe');
  await fs.writeFile(executable, '');
  const connections = [];
  let saved = '';
  let registration;
  const bridge = createChromeBridge({
    extensionId: 'a'.repeat(32), profileDir: dir, executable,
    getProfile: () => saved, saveProfile: id => { saved = id; },
    register: async file => { registration = JSON.parse(await fs.readFile(file)); },
    pipeAddress: () => path.join(dir, 'pipe'),
  });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await bridge.disconnect();
    await fs.rm(dir, { recursive: true });
  });
  assert.ok(await bridge.enable({ pair: true }));
  assert.deepEqual(registration.allowed_origins, ['chrome-extension://' + 'a'.repeat(32) + '/']);
  const config = JSON.parse(await fs.readFile(path.join(dir, 'chrome-bridge.json')));
  const connect = async (token, profile, focused) => {
    const socket = net.createConnection(config.pipe);
    connections.push(socket);
    await once(socket, 'connect');
    socket.write(Buffer.concat([frame({ token }), frame({ kind: 'profile', profile, focused })]));
    return socket;
  };
  const profile = '10e894e8-a8aa-4af5-92c7-eaad09c73212';
  const denied = await connect('0'.repeat(64), profile, true);
  await once(denied, 'close');
  assert.equal(bridge.status().connected, false);
  const hidden = await connect(config.token, profile, false);
  await once(hidden, 'close');
  assert.equal(bridge.status().connected, false);
  const allowed = await connect(config.token, profile, true);
  for (let i = 0; i < 15 && !bridge.status().connected; i++) await sleep(5);
  assert.equal(saved, profile);
  assert.equal(bridge.status().connected, true);
  const wrong = await connect(config.token, '20e894e8-a8aa-4af5-92c7-eaad09c73212', true);
  await once(wrong, 'close');
  assert.equal(bridge.status().connected, true);
  const receive = decode(message => {
    if (message.kind === 'observe') allowed.write(frame({ id: message.id, result: { ok: true, snapshot: 'fresh' } }));
  });
  allowed.on('data', receive);
  assert.deepEqual(await bridge.send({ kind: 'observe' }), { ok: true, snapshot: 'fresh' });
  const cancelled = bridge.send({ kind: 'restart' });
  await bridge.disconnect();
  assert.equal((await cancelled).ok, false);
  await assert.rejects(fs.stat(path.join(dir, 'chrome-bridge.json')), { code: 'ENOENT' });
});

test('browser actions stay bound to the observed tab, exact control, and foreground window', async () => {
  const fg = { hwnd: 1, pid: 21, process: 'chrome' };
  const task = { request: 'Type in the Chrome page', controller: new AbortController() };
  const sent = [];
  let front = fg;
  const browser = makeBrowserActions({
    foreground: async () => front,
    bridge: {
      status: () => ({ connected: true }),
      async send(payload) {
        sent.push(payload);
        if (payload.kind === 'observe') return { ok: true, target: { tab: 3, document: 'A', epoch: 1 }, snapshot: 'S', text: 'Store closes at six.',
          controls: [{ id: 10001, type: 'Edit', name: 'Search' }], tabs: [3] };
        return { ok: true };
      },
    },
  });
  const chrome = await browser.inspect(fg, task);
  const ctx = { chrome, fg, task };
  assert.equal((await browser.run('read_page', {}, ctx)).sourceData, 'Store closes at six.');
  assert.equal((await browser.run('type', { id: 10001, text: 'cats', submit: true }, ctx)).guarded, true);
  assert.equal((await browser.run('switch_tab', { tab: 4 }, ctx)).ok, false);
  assert.equal((await browser.run('click', { text: 'Search' }, ctx)).ok, false);
  assert.equal((await browser.run('type', { id: 10001, text: 'cats' }, ctx)).ok, true);
  assert.deepEqual(sent[1].target, { tab: 3, document: 'A', epoch: 1 });
  front = { ...fg, hwnd: 2 };
  assert.equal((await browser.run('type', { id: 10001, text: 'cats' }, ctx)).guarded, true);
  assert.equal(sent.length, 2);
});

test('cross-app tasks preserve the user’s preparation order without treating a recipient as an app', async () => {
  const request = 'Find support hours in Chrome, put them in Notepad, and draft an Outlook email to team@example.test';
  const compound = compoundRequest(request);
  assert.deepEqual(compound.apps, ['chrome', 'notepad', 'outlook']);
  assert.deepEqual(compound.workflows.map(x => x.spec.kind), ['document', 'email']);
  const workflowCalls = [];
  const agent = new HandsAgent({ send: () => {}, workflow: { async run(spec, text, options) {
    workflowCalls.push({ kind: spec.kind, text, data: options.sourceData });
    return { outcome: 'ok' };
  } } });
  const task = { compound, completed: new Set(), allowedWindows: new Set(), controller: new AbortController(), sourceData: 'Support is open until 6 p.m.' };
  assert.equal((await agent.prepareStep({ id: 2 }, task)).ok, false);
  assert.equal((await agent.prepareStep({ id: 1 }, task)).ok, true);
  assert.equal((await agent.prepareStep({ id: 2 }, task)).ok, true);
  assert.equal((await agent.prepareStep({ id: 2 }, task)).ok, false);
  assert.deepEqual(workflowCalls.map(x => x.kind), ['document', 'email']);
  assert.equal(workflowCalls[1].data, task.sourceData);
  assert.equal(compoundRequest('Draft an email to outlook@example.test'), null);
  assert.equal(willUseChrome('Open Chrome', { process: 'chrome' }), false);
});

test('Chrome setup runs only after the matching on-screen approval and resumes the same task', async () => {
  const events = [];
  const pending = createPending();
  const agent = new HandsAgent({
    send: (type, value) => events.push([type, value]),
    read: async () => ({ elements: [] }),
    llm: () => ({ ready: true, async complete() { return 'Done. [DONE]'; } }),
    consent: { preview: () => null, pending },
    chromeSetup: {
      needed: () => true, ready: () => true,
      connect: async () => { events.push(['connected']); return { ok: true, opened: true, nonce: 'setup-token' }; },
      closeSetup: async nonce => { events.push(['closed', nonce]); return { ok: true }; },
      cancel: () => {},
    },
  });
  const work = agent.run('Search Chrome for cats.', 'typed');
  await Promise.resolve();
  const card = events.find(([name]) => name === 'guide:bubble')[1];
  assert.equal(agent.answerFromBubble(true, 'another-task'), false);
  assert.equal(agent.spoken('yes', {}), 'needs-button');
  assert.equal(agent.answerFromBubble(true, card.sessionId), true);
  await work;
  assert.equal(agent.last.request, 'Search Chrome for cats.');
  assert.equal(agent.last.outcome, 'ok');
  assert.deepEqual(events.filter(([kind]) => kind === 'closed'), [['closed', 'setup-token']]);
});

test('the extension does not expose editable content or submit controls and invalidates used snapshots', async () => {
  const vm = require('node:vm');
  const { webcrypto } = require('node:crypto');
  const script = await fs.readFile(path.join(__dirname, '../../chrome-extension/page.js'), 'utf8');
  const dom = { focused: true, password: false, fields: [] };
  class MockInput {
    constructor(attrs = {}) {
      this.attrs = attrs;
      this.name = attrs.name || '';
      this.type = attrs.type || 'text';
      this.isContentEditable = attrs.editable || false;
      this.innerText = attrs.innerText || '';
      this.form = attrs.form || null;
      this.readOnly = false;
      this.disabled = false;
      this.textContent = this.innerText;
      this.value = '';
    }
    getAttribute(name) { return this.attrs[name] || ''; }
    getBoundingClientRect() { return { width: 10, height: 10 }; }
    closest(query) { return this.isContentEditable && query.includes('[contenteditable]') ? this : null; }
    matches(query) { return /input\[type=text\]/.test(query) && this.type === 'text'; }
    dispatchEvent() {}
    click() { this.clicked = true; }
    get value() { return this.currentValue; }
    set value(value) { this.currentValue = value; }
  }
  const city = new MockInput({ 'aria-label': 'City' });
  const submit = new MockInput({ type: 'submit', innerText: 'Submit', form: { querySelector: () => null, getAttribute: () => 'post' } });
  const editable = new MockInput({ editable: true, innerText: 'Existing private message' });
  dom.fields = [city, submit, editable];
  const env = {
    crypto: webcrypto, TextEncoder, HTMLAnchorElement: class {}, HTMLSelectElement: class {},
    HTMLTextAreaElement: class {}, HTMLInputElement: MockInput, Event: class {},
    NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ visibility: 'visible' }),
    location: { href: 'https://fixture.example/page', hostname: 'fixture.example', pathname: '/page' },
    document: {
      title: 'Fixture', body: {},
      getElementById: () => null,
      hasFocus: () => dom.focused, visibilityState: 'visible',
      querySelector: query => query === 'input[type=password]' && dom.password ? city : null,
      querySelectorAll: () => dom.fields,
      createTreeWalker: () => {
        const nodes = [{ parentElement: city, textContent: 'Public page' }, { parentElement: editable, textContent: editable.textContent }];
        return { nextNode: () => nodes.shift() };
      },
    },
  };
  city.isConnected = submit.isConnected = editable.isConnected = true;
  vm.createContext(env);
  vm.runInContext(script, env);
  const observed = vm.runInContext('observe()', env);
  assert.ok(observed.ok);
  assert.equal(observed.text, 'Public page');
  assert.ok(!JSON.stringify(observed).includes('Existing private message'));
  assert.ok(!observed.controls.some(c => c.name === 'Submit'));
  const command = { kind: 'fill', control: observed.controls.find(c => c.name === 'City').id, text: 'Riyadh', snapshot: observed.snapshot, deadline: Date.now() + 1000 };
  env.command = command;
  assert.equal(vm.runInContext('act(command)', env).ok, true);
  assert.equal(city.value, 'Riyadh');
  assert.equal(vm.runInContext('act(command)', env).reason, 'target-changed');
  dom.password = true;
  assert.equal(vm.runInContext('observe()', env).reason, 'protected');
});

test('Chrome execution rejects changed documents and tabs not opened by the task', async () => {
  const vm = require('node:vm');
  const { webcrypto } = require('node:crypto');
  const script = await fs.readFile(path.join(__dirname, '../../chrome-extension/background.js'), 'utf8');
  let tab = { id: 1, windowId: 8, url: 'https://fixture.example/page' };
  let documentId = 'original';
  let mutations = 0;
  const event = { addListener() {} };
  const env = {
    crypto: webcrypto, URL, Date,
    chrome: {
      runtime: { id: 'a'.repeat(32), onInstalled: event, onStartup: event,
        connectNative: () => ({ onDisconnect: event, onMessage: event, postMessage() {} }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      alarms: { onAlarm: event, create: async () => {} },
      windows: { getLastFocused: async () => ({ id: 8, focused: true, type: 'normal' }), onFocusChanged: event },
      webNavigation: { getFrame: async () => ({ documentId, documentLifecycle: 'active' }) },
      tabs: { onActivated: event, onRemoved: event, query: async () => [tab], sendMessage: async (_id, message) => {
        if (message.kind === 'observe') return { ok: true, snapshot: 'before', controls: [] };
        mutations++;
        return { ok: true };
      } },
    },
  };
  vm.createContext(env);
  vm.runInContext(script, env);
  const call = message => vm.runInContext('handle(' + JSON.stringify({ task: 'local-test', deadline: Date.now() + 1000, ...message }) + ')', env);
  const observed = await call({ kind: 'observe', start: true });
  assert.equal(observed.ok, true);
  documentId = 'changed';
  assert.equal((await call({ kind: 'click', target: observed.target, snapshot: observed.snapshot, control: 10001 })).reason, 'target-changed');
  tab = { ...tab, id: 2 };
  assert.equal((await call({ kind: 'observe' })).reason, 'target-changed');
  assert.equal(mutations, 0);
});

test('Hands carries observed Chrome facts through two verified app steps in one run', async () => {
  const request = 'Find support hours in Chrome, put them in Notepad, and draft an Outlook email to team@example.test';
  const compound = compoundRequest(request);
  let front = { hwnd: 9, pid: 91, process: 'chrome', title: 'Support' };
  const completed = [];
  const actions = [];
  let turn = 0;
  const replies = [
    'Reading the support hours. [DO:read_page {}] [DO:click {"id":10001}]',
    'Writing the hours. [DO:prepare_step {"id":1}]',
    'Drafting the email. [DO:prepare_step {"id":2}]',
    'The document and reviewable draft are ready. [DONE]',
  ];
  const agent = new HandsAgent({
    send: () => {}, oneActionPerLook: true,
    read: async () => ({ fg: front, elements: [{ id: 1, name: 'Text', type: 'Edit' }] }),
    llm: () => ({ ready: true, async complete() { return replies[turn++]; } }),
    actions: { async run(name) {
      actions.push(name);
      return { ok: true, noLook: true, sourceData: 'Support closes at 6.' };
    } },
    consent: { preview: () => null },
    workflow: { async run(spec, _words, options) {
      completed.push([spec.kind, options.sourceData]);
      front = spec.kind === 'document'
        ? { hwnd: 10, pid: 92, process: 'notepad', title: 'Notepad' }
        : { hwnd: 11, pid: 93, process: 'outlook', title: 'Outlook' };
      return { outcome: 'ok', target: front, text: 'Verified the result.' };
    } },
  });
  await agent.run(request, 'voice', { compound });
  assert.equal(agent.last.outcome, 'ok');
  assert.deepEqual(actions, ['read_page']);
  assert.deepEqual(completed, [['document', 'Support closes at 6.'], ['email', 'Support closes at 6.']]);
  assert.equal(turn, 4);
});

test('the task queue forwards Chrome task identity to observations and stops interrupted compound tasks', async () => {
  const { createHandsExecutor } = require('../src/tasks/executors/hands');
  const request = 'Search in Chrome, then write the results in Notepad';
  const observed = [];
  const emitted = [];
  const agent = new HandsAgent({
    send: () => {}, actions: { async run() { return { ok: true }; } }, compound: compoundRequest,
    maxSteps: 0, read: async task => { observed.push(task); return { elements: [] }; },
    llm: () => ({ ready: true, async complete() { return 'Working. [DO:look {}]'; } }),
    consent: { preview: () => null },
  });
  agent.d.maxSteps = 1;
  const executor = createHandsExecutor({ agent: () => agent });
  const ctx = { emit: (event, payload) => emitted.push([event, payload]) };
  await executor.run({ id: 'queue-chrome', request, source: 'typed' }, ctx);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].request, request);
  assert.equal(agent.canResume(), false);
  assert.ok(emitted.some(([event, payload]) => event === 'failed' && payload.class === 'interrupted'));
  await executor.run({ id: 'queue-chrome', request, source: 'typed' }, { ...ctx, resumed: true });
  assert.equal(observed.length, 1);
});

test('a second window of the same app cannot inherit a verified desktop target', async () => {
  const first = { hwnd: 1, pid: 8, process: 'chrome', title: 'Chrome' };
  const expected = { hwnd: 2, pid: 9, process: 'notepad', title: 'Task document' };
  const unrelated = { ...expected, hwnd: 3, title: 'Different document' };
  let front = first;
  const actions = [];
  const agent = new HandsAgent({
    send: () => {}, oneActionPerLook: true,
    read: async () => ({ fg: front, elements: [{ id: 1, name: 'Text' }] }),
    llm: () => ({ ready: true, async complete() { return '[DO:open_app {"name":"Notepad"}]'; } }),
    actions: { async run(name, _args, ctx) {
      actions.push(name);
      ctx.target = { name: 'Notepad', process: 'notepad' };
      ctx.fg = expected;
      front = unrelated;
      return { ok: true, noLook: true };
    } },
    consent: { preview: () => null },
  });
  await agent.run('Open Notepad and type hello.', 'typed');
  assert.equal(agent.last.outcome, 'away');
  assert.deepEqual(actions, ['open_app']);
});
