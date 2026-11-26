'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWorkflows, workflowRequest, manualFinishRequest } = require('../src/hands/workflows');
const { createActions } = require('../src/hands/actions');
const { HandsAgent } = require('../src/hands/agent');
const { createReflex } = require('../src/reflex');

const control = (id, type, name, extras = {}) => ({ id, rid: '9,' + id, type, name, enabled: true, web: true, ...extras });
const browser = (url, controls, extras = {}) => ({ fg: { hwnd: 1, pid: 20, process: 'chrome' }, tab: '1,2', view: '3,4', url, controls, ...extras });
const FORM = 'https://docs.google.com/forms/d/e/test/viewform';
const MAIL = 'https://mail.google.com/mail/u/0/#inbox';
const doc = (extra = {}) => ({ fg: { hwnd: 9, pid: 8, process: 'notepad' }, editor: '9,40', view: '9,40', controls: [], ...extra });
const run = (r, text, options = {}) => r.workflow.run(workflowRequest(text), text, { signal: new AbortController().signal, ...options });

function fixture(initial, reply, onEdit, onOpen) {
  let front = initial;
  const edits = [], opens = [], pastes = [], prompts = [];
  const model = () => ({ ready: true, complete: async (params) => {
    prompts.push(params);
    return JSON.stringify(typeof reply === 'function' ? await reply(params, fixture) : reply);
  } });
  const fixture = {
    set: (value) => { front = value; },
    get: () => front, edits, opens, pastes, prompts,
    workflow: createWorkflows({
      read: async () => front,
      edit: async (op) => { edits.push(op); return onEdit ? onEdit(op, fixture) : { ok: true }; },
      open: async (spec) => { opens.push(spec); return onOpen ? onOpen(spec, fixture) : true; },
      draftModel: model, screenModel: model,
      capture: async () => 'data:image/png;base64,fixture', pause: async () => {}, progress() {},
      pasteDocument: async (args) => { pastes.push(args); return { ok: true, verified: true }; },
    }),
  };
  return fixture;
}

test('requests distinguish preparation, local dictation and manual finish', () => {
  assert.deepEqual(workflowRequest('Draft an email in Gmail to pat@example.com saying hello'), { kind: 'email', client: 'gmail', web: true });
  assert.equal(workflowRequest('Fill the survey in Edge').kind, 'survey');
  assert.equal(workflowRequest('Open Notepad and write a shopping list').kind, 'document');
  assert.equal(workflowRequest('Revise the selected text in Word').selection, true);
  assert.equal(workflowRequest('Open Notepad and type hello'), null);
  assert.equal(workflowRequest('Where is the submit button on this form?'), null);
  assert.equal(manualFinishRequest('Please submit the survey.'), true);
  assert.equal(manualFinishRequest('Send an email to pat@example.com saying hello'), false);
});

test('email prepares verified compose fields and stops at review', async () => {
  const to = control(1, 'Edit', 'To');
  const subject = control(2, 'Edit', 'Subject');
  const body = control(3, 'Edit', 'Message Body');
  const send = control(4, 'Button', 'Send');
  const compose = control(5, 'Button', 'Compose');
  const r = fixture(browser(MAIL, [compose]), { subject: 'Update', body: 'I finished the draft.' }, (op, f) => {
    if (op.op === 'compose') f.set(browser(MAIL + '/compose', [to, subject, body, send]));
    if (op.field === 'to') f.set({ ...f.get(), recipients: op.value });
    return { ok: true };
  });
  const result = await run(r, 'Draft an email in Gmail to pat@example.com saying I finished the draft');
  assert.equal(result.outcome, 'ok');
  assert.match(result.text, /Click Send/);
  assert.deepEqual(r.edits.map((e) => [e.op, e.control.name, e.value]), [
    ['compose', 'Compose', undefined], ['email-field', 'To', 'pat@example.com'],
    ['email-field', 'Subject', 'Update'], ['email-field', 'Message Body', 'I finished the draft.'],
  ]);
  assert.equal(r.prompts[0].imageDataUrl, undefined);
});

test('missing, conflicting and ambiguous email recipients leave the draft untouched', async () => {
  const front = browser(MAIL, [control(2, 'Edit', 'Message Body'), control(3, 'Button', 'Send')]);
  for (const [request, rec] of [
    ['Draft an email to Pat', ''],
    ['Draft an email to pat@example.com and other@example.com', ''],
    ['Draft an email to pat@example.com', 'other@example.com'],
  ]) {
    const r = fixture({ ...front, recipients: rec }, {});
    assert.equal((await run(r, request)).outcome, 'asked');
    assert.deepEqual(r.edits, []);
    assert.deepEqual(r.prompts, []);
  }
});

test('an explicit recipient supplied on a follow-up resumes the pinned draft', async () => {
  const front = browser(MAIL, [control(1, 'Edit', 'To'), control(2, 'Edit', 'Subject'), control(3, 'Edit', 'Body')]);
  const r = fixture(front, { subject: 'Update', body: 'I am running late.' }, (step, f) => {
    if (step.field === 'to') f.set({ ...front, recipients: step.value });
    return { ok: true };
  });
  const text = 'Draft an email in Gmail saying I am running late';
  const first = await run(r, text);
  assert.equal(first.outcome, 'asked');
  const done = await run(r, text + '\nAdditional instructions: recipient is pat@example.com', { previous: first.target });
  assert.equal(done.outcome, 'ok');
  assert.equal(r.edits[0].value, 'pat@example.com');
});

test('email gives a clear handoff if an address cannot be committed', async () => {
  const to = control(1, 'Edit', 'To');
  const subject = control(2, 'Edit', 'Subject');
  const body = control(3, 'Edit', 'Message body');
  const r = fixture(browser(MAIL, [to, subject, body]), { subject: 'Hi', body: 'Hi there.' });
  const done = await run(r, 'Draft an email in Gmail to pat@example.com saying hi');
  assert.equal(done.outcome, 'asked');
  assert.match(done.text, /Confirm the recipient/);
  assert.deepEqual(r.edits.map((e) => e.field), ['to', 'subject', 'body']);
});

test('required private fields are left to the user and block automatic navigation', async () => {
  const r = fixture(browser(FORM, [control(1, 'Edit', 'Verification code', { required: true }), control(2, 'Button', 'Next')]), { answers: [{ id: 1, value: '1234' }], missing: [] });
  assert.match((await run(r, 'Fill the survey with 1234')).text, /private fields yourself/);
  assert.deepEqual(r.edits, []);
});

test('a Microsoft Forms short link must open a verified new form page', async () => {
  const old = browser('https://forms.office.com/Pages/ResponsePage.aspx?id=old', [control(1, 'Edit', 'Old question')]);
  const fresh = browser('https://forms.office.com/Pages/ResponsePage.aspx?id=new', [control(2, 'Edit', 'New question'), control(3, 'Button', 'Submit')], { tab: 'new' });
  const model = { answers: [{ id: 2, value: 'Fine' }], missing: [] };
  const request = 'Fill this survey https://forms.office.com/r/example with Fine';
  const r = fixture(old, model, null, (_spec, f) => { f.set(fresh); return true; });
  assert.equal((await run(r, request)).outcome, 'ok');
  assert.deepEqual(r.edits.map((e) => e.control.name), ['New question']);
  const stale = fixture(old, model);
  assert.equal((await run(stale, request)).outcome, 'away');
  assert.deepEqual(stale.edits, []);
});

test('a browser tab change invalidates a pending edit and a resumed workflow', async () => {
  const controls = [control(1, 'Edit', 'Comment'), control(2, 'Button', 'Submit')];
  const initial = browser(FORM, controls);
  const r = fixture(initial, (_params, f) => {
    f.set(browser(FORM, controls, { tab: 'new-tab' }));
    return { answers: [{ id: 1, value: 'Great' }], missing: [] };
  });
  const text = 'Fill this survey with comment Great';
  const result = await run(r, text);
  assert.equal(result.outcome, 'away');
  assert.equal((await run(r, text, { previous: result.target })).outcome, 'away');
  assert.equal(r.edits.length, 0);
});

test('survey advances through Next and excludes private, invented, repeated and final actions', async () => {
  const page1 = browser(FORM, [
    control(1, 'RadioButton', 'Good', { group: 'Rating', required: true }),
    control(2, 'Edit', 'PIN'), control(3, 'Button', 'Next'),
  ]);
  const page2 = browser(FORM, [
    control(4, 'Edit', 'Comment'), control(5, 'Edit', 'Required name', { required: true }),
    control(6, 'Button', 'Submit'), control(7, 'ListItem', 'Submit'),
  ], { view: 'view-two' });
  const r = fixture(page1, (p) => {
    assert.equal(p.imageDataUrl, 'data:image/png;base64,fixture');
    return { answers: [{ id: 1, value: 'Good' }, { id: 1, value: 'Good' }, { id: 2, value: '1234' }, { id: 4, value: 'Thank you' }, { id: 5, value: 'Invented' }, { id: 6, value: 'Submit' }, { id: 7, value: 'Submit' }], missing: [5] };
  }, (op, f) => {
    if (op.op === 'next') f.set(page2);
    return { ok: true };
  });
  const result = await run(r, 'Fill this survey with rating Good and comment Thank you. The unused examples are 1234 and Submit.');
  assert.match(result.text, /filled 2 answers/i);
  assert.match(result.text, /Required name/);
  assert.match(result.text, /submit it yourself/);
  assert.deepEqual(r.edits.map((e) => [e.op, e.control.name]), [['choose', 'Good'], ['next', 'Next'], ['field', 'Comment']]);
});

test('cancelled proposals cannot write and document edits use the selected text', async () => {
  const selection = 'The orginal line.';
  const initial = doc({ selection });
  const ctl = new AbortController();
  const r = fixture(initial, (params) => {
    assert.equal(JSON.parse(params.turns[0].text).selection, selection);
    return { text: 'The original line.' };
  });
  const result = await run(r, 'Rewrite the selected text in Notepad');
  assert.equal(result.outcome, 'ok');
  assert.equal(r.pastes[0].selection, selection);
  const cancelled = fixture(doc({ emptyDocument: true }), () => { ctl.abort(); return { text: 'Late text' }; });
  assert.equal((await run(cancelled, 'Write a new note in Notepad', { signal: ctl.signal })).outcome, 'away');
  assert.deepEqual(cancelled.pastes, []);
});

test('generic Hands cannot bypass manual finish with coordinates or keys', async () => {
  const results = [];
  const a = createActions({
    inspectWorkflow: async () => browser(FORM, [control(1, 'Button', 'Submit')]),
    hands: { request: async (...args) => results.push(args) },
  });
  for (const [name, args] of [['press', { keys: 'ctrl+enter' }], ['click', { x: .4, y: .4 }], ['type', { submit: true, text: 'Submit' }]]) {
    assert.equal((await a.run(name, args, {})).guarded, true);
  }
  assert.deepEqual(results, []);
});

test('Hands cancellation aborts a workflow and ignores its eventual result', async () => {
  let signal, finish;
  const a = new HandsAgent({ send() {}, workflow: { run: (_spec, _text, opts) => {
    signal = opts.signal;
    return new Promise((resolve) => { finish = resolve; });
  } } });
  const running = a.run('Draft an email to pat@example.com', 'typed');
  a.stop('esc');
  assert.equal(signal.aborted, true);
  finish({ outcome: 'ok', text: 'Late' });
  await running;
  assert.equal(a.active(), false);
  assert.equal(a.last.outcome, 'stopped');
});

test('local app matching sees Unicode, long names, ambiguity and new installs beyond the model cap', async () => {
  const catalog = Array.from({ length: 205 }, (_, n) => ({ name: 'App ' + n, appId: 'test-' + n }));
  catalog.push({ name: '7-Zip ファイル Manager (x64)', appId: '7zip' });
  const opened = [], choices = [];
  let scans = 0;
  const r = createReflex({
    probe: { request: async (op) => {
      if (op === 'apps.list') return { apps: ++scans === 1 ? catalog : [...catalog, { name: 'Newly Installed', appId: 'new' }, { name: 'Notes Pro', appId: 'v1' }, { name: 'Notes Pro', appId: 'v2' }] };
      return { hwnd: 1, process: 'test' };
    } },
    shell: {}, jevClient: { ready: () => true, systemOne: async ({ state }) => {
      assert.equal(state.utterance, 'hello', 'only connection warmup reaches the classifier');
      return { answers: {} };
    } },
    onAppChoices: (apps) => choices.push(apps.map((x) => x.appId)),
    spawnFn: (_exe, args) => { opened.push(args[0]); return { unref() {} }; },
  });
  await r.start();
  await r.handle('Open 7-Zip ファイル Manager (x64)', { keyed: true, final: true });
  await r.handle('Open Newly Installed', { keyed: true, final: true });
  assert.equal((await r.handle('Open Notes Pro', { keyed: true, final: true })).held, 'choose app');
  await r.launchInstalled('v2');
  assert.equal(scans, 2);
  assert.deepEqual(choices, [['v1', 'v2']]);
  assert.deepEqual(opened, ['shell:AppsFolder\\7zip', 'shell:AppsFolder\\new', 'shell:AppsFolder\\v2']);
});
