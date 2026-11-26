'use strict';

const HOST = 'com.kaashify.chrome';
const TASK_TTL_MS = 120000;
const STALE = { ok: false, reason: 'target-changed' };
let port;
let epoch = 0;
let task;
let requestQueue = Promise.resolve();
let profileId;

async function profile() {
  if (!profileId) profileId = (await chrome.storage.local.get('profile')).profile;
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profile: profileId });
  }
  return profileId;
}

function webUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

async function foreground() {
  const win = await chrome.windows.getLastFocused();
  if (!win.focused || win.incognito || win.type !== 'normal') return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab || null;
}

async function observe(tab) {
  const basic = tab.url === 'chrome://newtab/';
  if (!basic && !webUrl(tab.url)) return { ok: false, reason: 'browser-page' };
  const startEpoch = epoch;
  const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
  if (!frame?.documentId || frame.documentLifecycle !== 'active' || tab.pendingUrl) return STALE;
  const target = { tab: tab.id, document: frame.documentId, epoch: startEpoch };
  if (basic) return { ok: true, basic: true, snapshot: 'new-tab', target, controls: [], text: '' };
  const snapshot = await chrome.tabs.sendMessage(tab.id, { kind: 'observe' }, { documentId: frame.documentId });
  if (startEpoch !== epoch) return STALE;
  return snapshot?.ok ? { ...snapshot, target } : snapshot;
}

async function handle(message) {
  if (!Number.isSafeInteger(message.deadline) || Date.now() > message.deadline) return STALE;
  const tab = await foreground();
  if (!tab) return STALE;
  if (message.kind === 'finish-setup') {
    const url = new URL(tab.url);
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    if (url.origin === 'https://chromewebstore.google.com' && url.pathname.startsWith('/detail/') &&
        url.pathname.split('/').at(-1) === chrome.runtime.id && /^[a-f0-9]{32}$/.test(message.nonce || '') &&
        url.hash === '#kaashify-setup=' + message.nonce && tabs.length === 1) {
      const current = await foreground();
      if (current?.id === tab.id && current.url === tab.url && Date.now() <= message.deadline) {
        await chrome.tabs.remove(tab.id);
        return { ok: true };
      }
    }
    return STALE;
  }
  if (!message.task) return STALE;
  if (task?.id !== message.task || task.expires < Date.now()) {
    if (message.kind !== 'observe' || !message.start) return STALE;
    task = { id: message.task, window: tab.windowId, tabs: new Set([tab.id]), expires: Date.now() + TASK_TTL_MS };
  }
  if (task.window !== tab.windowId || !task.tabs.has(tab.id)) return STALE;
  task.expires = Date.now() + TASK_TTL_MS;
  if (message.kind === 'observe') {
    const result = await observe(tab);
    return task?.id === message.task && result?.ok
      ? { ...result, tabs: Array.from(task.tabs) }
      : result;
  }
  if (message.target?.tab !== tab.id || message.target.epoch !== epoch) return STALE;
  const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
  if (task?.id !== message.task || epoch !== message.target.epoch || !frame || frame.documentLifecycle !== 'active' || frame.documentId !== message.target.document || tab.pendingUrl || Date.now() > message.deadline) return STALE;
  if (message.kind === 'open-tab') {
    const url = webUrl(message.url);
    if (!url || task.tabs.size >= 8) return { ok: false, reason: 'unsupported' };
    const opened = await chrome.tabs.create({ url, windowId: task.window, active: true, openerTabId: tab.id });
    task.tabs.add(opened.id);
    return { ok: true };
  }
  if (message.kind === 'switch-tab') {
    const destination = message.tab;
    if (!task.tabs.has(destination) || (await chrome.tabs.get(destination)).windowId !== task.window) return STALE;
    if (task?.id !== message.task || epoch !== message.target.epoch || Date.now() > message.deadline) return STALE;
    await chrome.tabs.update(destination, { active: true });
    return { ok: true };
  }
  if (message.kind === 'navigate') {
    const url = webUrl(message.url);
    if (!url || task?.id !== message.task || epoch !== message.target.epoch || Date.now() > message.deadline) return STALE;
    await chrome.tabs.update(tab.id, { url });
    return { ok: true };
  }
  if (!['click', 'fill', 'scroll'].includes(message.kind)) return { ok: false, reason: 'unsupported' };
  if (task?.id !== message.task || epoch !== message.target.epoch || Date.now() > message.deadline) return STALE;
  return chrome.tabs.sendMessage(tab.id, {
    kind: message.kind, snapshot: message.snapshot, control: message.control,
    text: message.text, append: message.append === true, direction: message.direction, deadline: message.deadline,
  }, { documentId: frame.documentId });
}

async function connect() {
  if (port) return;
  const current = chrome.runtime.connectNative(HOST);
  port = current;
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === current) { port = null; task = null; }
  });
  current.onMessage.addListener(message => {
    if (message?.kind === 'cancel') { if (task?.id === message.task) task = null; return; }
    requestQueue = requestQueue.catch(() => {}).then(async () => {
      if (port !== current || typeof message?.id !== 'string') return;
      let result;
      try { result = await handle(message); } catch { result = { ok: false, reason: 'browser-unavailable' }; }
      if (port === current) current.postMessage({ id: message.id, result });
    });
  });
  const id = await profile();
  const active = await foreground().catch(() => null);
  if (port === current) current.postMessage({ kind: 'profile', profile: id, focused: !!active });
}

chrome.tabs.onActivated.addListener(() => { epoch++; void connect().catch(() => {}); });
chrome.windows.onFocusChanged.addListener(() => { epoch++; void connect().catch(() => {}); });
chrome.tabs.onRemoved.addListener(id => task?.tabs.delete(id));
chrome.runtime.onInstalled.addListener(() => void connect().catch(() => {}));
chrome.runtime.onStartup.addListener(() => void connect().catch(() => {}));
chrome.alarms.onAlarm.addListener(() => void connect().catch(() => {}));
void chrome.alarms.create('kaashify-connect', { periodInMinutes: 0.5 });
void connect().catch(() => {});
