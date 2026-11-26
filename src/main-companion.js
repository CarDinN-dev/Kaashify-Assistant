const path = require('node:path');
const captureWorker = path.resolve(__dirname, '../companion/src/guide/capture-worker.js');
if (typeof process.send === 'function' && process.argv[1] === captureWorker) {
  require('../companion/src/guide/capture-worker');
  return;
}

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
const { pathToFileURL } = require('url');
function dataDirFromArgv(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (arg.startsWith('--data-dir=')) return arg.slice('--data-dir='.length);
    if (arg === '--data-dir' && argv[i + 1]) return argv[i + 1];
  }
  if (process.env.KAASHIFY_COMPANION_DATA_DIR) return process.env.KAASHIFY_COMPANION_DATA_DIR;
  return null;
}
app.setName('Kaashify');
if (process.platform === 'win32') app.setAppUserModelId('com.kaashify.desktop');
const dir = dataDirFromArgv();
app.setPath('userData', dir ? path.resolve(dir) : path.join(app.getPath('appData'), 'Kaashify'));
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
// The lag recorder (companion/src/lag): off in a normal install; on in a dev run, with KAASHIFY_LAG=1, or
// with a lag-on.txt in the profile. It wraps IPC and timers, so it goes in before anything registers.
require('../companion/src/lag').install({ version: app.isPackaged ? app.getVersion() : 'dev' });
let home = null, companion = null, folders = null, databaseReady = false;
const { createAutostart, isLoginLaunch } = require('./autostart');
// A second copy the person started (the shortcut, with Kaashify already in the tray) opens the dashboard
// and is a real action. One that Windows started at sign-in is neither: it is ignored (src/autostart.js).
app.on('second-instance', (_event, argv) => {
  if (isLoginLaunch(argv)) return;
  if (databaseReady && app.isReady()) openHome();
});
require('./crash').installCrashHandlers(app, dialog);
const { createQuitGuard } = require('./quit-guard');
const companionApp = require('../companion');
const store = require('../companion/src/store');
store.setStandalone(true);
const ai = require('./ai');
const secrets = require('./secrets');
const sttLocal = require('./stt-local');
const { open, api, setSaveStateListener } = require('./db');
const { createLLM } = require('../companion/src/llm');
const { MODEL_SLOTS, isModelProvider, modelSettingsPatch } = require('../companion/src/models');
const routines = require('../companion/src/reflex/routines');
const { INTENTS } = require('../companion/src/reflex/router');
const { normalizeFeeds } = require('../companion/src/reflex/focus-guard');
const { createFolders, inside } = require('../companion/home/folders');
const solveBudget = require('../companion/src/guide/solve-budget');
const { createExamGuard, MESSAGE: EXAM_MESSAGE } = require('../companion/src/win/examguard');
const getStarted = require('../companion/src/get-started');
const tourMod = require('../companion/src/tour');
const userData = app.getPath('userData');
const routinesFile = path.join(userData, 'reflex-routines.json');
const notesFile = path.join(userData, 'companion', 'notes.md');
const homeFile = path.join(__dirname, '..', 'companion', 'home', 'index.html');
const SMOKE = process.argv.includes('--smoke');
const WINDOWS = process.platform === 'win32';
const SUPPORT_URL = 'https://www.kaashify.com/contact';
const ALLOWED_EXTERNAL = new Set(['https://typesafe.ai', 'https://aistudio.google.com/apikey', 'https://console.anthropic.com', 'https://build.nvidia.com/settings/api-keys', 'https://platform.openai.com/api-keys', SUPPORT_URL]);
function send(channel, value) { if (home && !home.isDestroyed()) home.webContents.send(channel, value); }
// Packaged: the version electron-builder stamped. A dev run reports Electron's
// own version from app.getVersion(), so read the build config instead.
function companionVersion() {
  if (app.isPackaged) return app.getVersion();
  try { return require('../electron-builder.companion.config').extraMetadata.version + '-dev'; } catch { return app.getVersion(); }
}
function notes() { try { return fs.readFileSync(notesFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } }
function lifestyleSnapshot() {
  const keeps = companion ? companion.keeps() : [];
  const grouped = new Map();
  for (const item of keeps) { const name = item.app.process; if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(item.task); }
  return { schema_version: 1, generated_at: new Date().toISOString(), product: 'Kaashify',
    folders: (folders ? folders.list() : []).map(f => ({ label: f.label, files: f.files, enabled: f.enabled })),
    routines: routines.load(routinesFile).map(r => ({ name: r.name, steps: r.steps.length })),
    keeps: [...grouped].map(([app, tasks]) => ({ app, tasks })),
    sessions_today: api.listCompanionSessions().filter(s => new Date(s.started_at).toDateString() === new Date().toDateString()).length,
    notes: notes().length, next_moves: [] };
}
function openHome() {
  if (home && !home.isDestroyed()) { if (home.isMinimized()) home.restore(); home.show(); home.focus(); return home; }
  home = new BrowserWindow({ width: 1100, height: 720, minWidth: 640, minHeight: 460, backgroundColor: '#0b0d12', title: 'Kaashify Dashboard',
    webPreferences: { preload: path.join(__dirname, '..', 'companion', 'home', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  home.setMenuBarVisibility(false);
  // The Companion window follows the same "hidden from screen sharing" switch
  // as Kaashify; until 0.1.2 it was captured while the overlay was not.
  // The dashboard is never hidden from screen sharing (Pranav, 2026-11-03); only Kaashify follows the switch.
  home.setContentProtection(false);
  home.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  home.webContents.on('will-navigate', e => e.preventDefault());
  for (const [key, value] of Object.entries(tourMod.onFirstWindow(api.getPreferences()))) api.setPreference(key, value);
  home.on('closed', () => { home = null; });
  home.loadFile(homeFile);
  api.setPreference('home_seen', true);
  return home;
}
function publicSettings() {
  const s = store.rendererSettings();
  let dictation = { on: false, why: '', keys: 'Ctrl + Win' };
  try { if (companion && companion.dictation) dictation = companion.dictation(); } catch (_) { /* the switch shows off */ }
  return { ...s, openMic: s.openMic ?? (process.env.KAASHIFY_REFLEX_OPENMIC === '1'), _dictation: dictation };
}
// One key store. The Companion's settings (companion/src/store.js, encrypted)
// hold every key; the desktop-side Claude client (src/ai.js, shared with the
// student app) reads its Anthropic key from secrets.js, so that copy is kept
// as a mirror of the store, written here and only here.
function mirrorAnthropicKey(value) {
  const key = String(value || '').trim();
  try { if (key) ai.setApiKey(key); else ai.clearApiKey(); } catch (e) { console.log('[kaashify] anthropic key mirror failed:', e.message); }
}
// 0.1.1 profiles saved the Anthropic key only in secrets.js; carry it into
// the store once so the checklist and the provider switch can see it.
function adoptLegacyAnthropicKey() {
  const s = store.getSettings();
  if (s.apiKeys && s.apiKeys.anthropic) { mirrorAnthropicKey(s.apiKeys.anthropic); return; }
  const legacy = secrets.getSecret('anthropic_api_key');
  if (legacy) store.setSettings({ apiKeys: { anthropic: legacy } });
}
// Start with Windows: a login item that runs this exe with --autostart, under one fixed name
// (src/autostart.js). Only a packaged build registers one; a dev run would register electron.exe.
const autostart = createAutostart({ app, log: m => console.log(m) });
function applyAutostart(on) { autostart.apply(on); }
function settingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
  const clean = modelSettingsPatch(patch);
  for (const key of ['openMic', 'apiSpeech', 'wakeCommands', 'persistTranscripts', 'saveAudio', 'speakReplies', 'smart', 'proactive', 'hideFromCapture', 'sounds', 'focusGuard', 'tasks', 'hands', 'knotIsland']) if (typeof patch[key] === 'boolean') clean[key] = patch[key];
  // Draw on the screen (0.1.38): answers about the screen mark what they talk about.
  if (typeof patch.drawOnScreen === 'boolean') clean.drawOnScreen = patch.drawOnScreen;
  if (typeof patch.startWithWindows === 'boolean') clean.startWithWindows = patch.startWithWindows;
  // Dictation (Ctrl + Win): set here, it wins over the install's half of the 0.1.37 test.
  if (typeof patch.dictation === 'boolean') clean.dictation = patch.dictation;
  // The feed titles the focus guard closes: short words, at most 20, deduplicated.
  if (Array.isArray(patch.focusGuardFeeds) || typeof patch.focusGuardFeeds === 'string') clean.focusGuardFeeds = normalizeFeeds(patch.focusGuardFeeds);
  // Kaashify's voice: the system one, or a named local voice (companion/src/voice).
  if (patch.voice === 'system' || patch.voice === 'fable') clean.voice = patch.voice;
  // The microphone (Settings, Voice): a device id and its name, '' for the Windows default.
  for (const key of ['micDeviceId', 'micDeviceLabel']) if (typeof patch[key] === 'string' && patch[key].length <= 512) clean[key] = patch[key];
  // What writes down a finished sentence: unset or parakeet means Parakeet once installed, whisper keeps Whisper (companion/src/voice/parakeet.js).
  if (patch.speechModel === 'whisper' || patch.speechModel === 'parakeet') clean.speechModel = patch.speechModel;
  if (patch.apiKeys && typeof patch.apiKeys === 'object') {
    clean.apiKeys = {};
    for (const key of ['typesafe','gemini','anthropic','openai','nvidia']) {
      if (typeof patch.apiKeys[key] !== 'string') continue;
      const value = patch.apiKeys[key].trim();
      if (value.length > 4096) throw new Error('That API key is too long. Check what you pasted.');
      clean.apiKeys[key] = value;
    }
    const current = store.getSettings();
    const keys = { ...current.apiKeys, ...clean.apiKeys };
    const providers = ['gemini', 'anthropic', 'nvidia', 'openai'];
    const added = providers.find(provider => clean.apiKeys[provider]);
    if (!clean.provider && (added === 'gemini' || !keys[current.provider])) {
      clean.provider = providers.find(provider => keys[provider]) || current.provider;
    }
  }
  if (Number.isFinite(patch.audioRetentionDays)) clean.audioRetentionDays = Math.max(1, Math.min(365, Math.round(patch.audioRetentionDays)));
  if (['tl','tr','bl','br'].includes(patch.knotCorner)) clean.knotCorner = patch.knotCorner;
  if (patch.knotDisplayId === null || screen.getAllDisplays().some(d => d.id === patch.knotDisplayId)) clean.knotDisplayId = patch.knotDisplayId;
  companion.setSettings(clean);
  if (typeof clean.startWithWindows === 'boolean') applyAutostart(clean.startWithWindows);
  if (store.saveError()) throw new Error('Changes apply until Kaashify quits. Could not save settings to this device.');
  if (clean.apiKeys && Object.prototype.hasOwnProperty.call(clean.apiKeys, 'anthropic')) mirrorAnthropicKey(clean.apiKeys.anthropic);
  return publicSettings();
}
// The checklist: one short call per key, so a person knows which one is
// wrong before Kaashify has to fail in front of them. Errors are clipped and
// never echo the key.
function scrub(text, keys) {
  let out = String(text || '');
  for (const k of keys.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(k).join('[key]');
  return out.slice(0, 400);
}
async function timed(fn) {
  const t0 = Date.now();
  try { const r = await fn(); return { ok: r === true || (r && r.ok !== false && !r.error), ms: Date.now() - t0, error: r && r.error ? String(r.error) : '' }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) }; }
}
async function testKeys(which) {
  const s = store.getSettings();
  const keys = Object.values(s.apiKeys || {});
  const jev = require('../companion/src/reflex/jev');
  const ping = provider => async () => {
    // ownKey: test the key itself, even while publik answers the asks (0.1.36; it pinged publik).
    const llm = createLLM({ ...s, provider, smart: false }, { ownKey: true });
    if (!llm.ready) return { error: 'no key' };
    const text = await llm.complete({ system: 'Reply with exactly the word OK.', turns: [{ role: 'user', text: 'ping' }], maxTokens: 1024 });
    return /^ok[.!]*$/i.test(String(text ?? '').trim()) ? { ok: true } : { error: 'The provider returned an unexpected test response.' };
  };
  const tests = {
    typesafe: () => jev.ready() ? timed(() => jev.systemOne({ state: { ping: 'ping' }, questions: { ok: jev.noul('Is the state a ping?') }, timeoutMs: 4000, retries: 0 })) : { ok: false, ms: 0, error: 'no key' },
    gemini: () => s.apiKeys.gemini ? timed(ping('gemini')) : { ok: false, ms: 0, error: 'no key' },
    nvidia: () => s.apiKeys.nvidia ? timed(ping('nvidia')) : { ok: false, ms: 0, error: 'no key' },
    anthropic: () => s.apiKeys.anthropic ? timed(ping('anthropic')) : { ok: false, ms: 0, error: 'no key' },
    openai: () => s.apiKeys.openai ? timed(ping('openai')) : { ok: false, ms: 0, error: 'no key' },
    cli: async () => (await ai.status()).cli ? timed(() => ai.testConnection()) : { ok: false, ms: 0, error: 'not installed' },
  };
  // One row at a time: Claude Code alone takes seconds, and a missing key
  // should answer at once.
  if (which && !Object.hasOwn(tests, which)) throw new Error('Unknown provider.');
  const names = which ? [which] : Object.keys(tests);
  const out = {};
  // Each failure gets one plain sentence (Apple review fix 4); the scrubbed raw
  // text stays as `error` for the Details line.
  for (const k of names) { out[k] = await tests[k](); out[k].error = scrub(out[k].error, keys); if (!out[k].ok && out[k].error) out[k].message = getStarted.plainKeyError(k, out[k].error); }
  return out;
}
// Only this generated swatch is sent by the screen model check.
const MODEL_TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfH/pjERIbw4xAGC3Cbs/bXDRc0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa8NgFD/zhh3sicN8AAAAASUVORK5CYII=';

async function testModel(request) {
  const { provider, slot, modelId, smart } = request || {};
  if (!isModelProvider(provider) || !MODEL_SLOTS.includes(slot) || typeof modelId !== 'string') throw new Error('Invalid model selection.');
  const settings = store.getSettings();
  const patch = modelSettingsPatch({ models: { [provider]: { [slot]: modelId } } });
  const models = { ...settings.models, [provider]: { ...settings.models?.[provider], ...patch.models[provider] } };
  const llm = createLLM({ ...settings, provider, smart: slot === 'smart' || (slot === 'vision' && smart === true), models }, { ownKey: true });
  if (!llm.ready) return { ok: false, error: 'Save a key for this provider before testing the model.' };
  const image = slot === 'vision';
  const result = await timed(async () => {
    const text = await llm.complete({
      system: 'Follow the user’s requested response format.',
      turns: [{ role: 'user', text: image ? 'What color is the image? Answer in one word.' : 'Reply with exactly the word OK.' }],
      imageDataUrl: image ? MODEL_TEST_IMAGE : undefined,
      maxTokens: 1024,
      signal: AbortSignal.timeout(15000),
    });
    const pass = (image ? /^(?:magenta|purple|fuchsia|pink)[.!]*$/i : /^ok[.!]*$/i).test(String(text || '').trim());
    return pass ? { ok: true } : { error: image ? 'The model could not identify the color in the sample image.' : 'The model returned an unexpected text response.' };
  });
  return { ...result, error: scrub(result.error, Object.values(settings.apiKeys || {})) };
}

// Get started, step 1. Claude Code: one real answer through the pool proves it
// is installed and signed in. Gemini: the pasted key answers one word before it
// is saved, so a bad key never becomes the answer source.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]).finally(() => clearTimeout(timer));
}
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!home || home.isDestroyed() || event.sender !== home.webContents || event.senderFrame !== home.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(homeFile).href) throw new Error('Untrusted home caller.');
    return fn(...args);
  });
}
function registerHomeIpc() {
  handle('home:status', async () => {
    const state = companion.status();
    return {
      ...state,
      ai: await ai.status(),
      llmReady: createLLM(store.getSettings()).ready,
      version: companionVersion(),
      hotkeys: { ptt: state.ptt.accelerator, assist: store.getSettings().shortcuts.assist, ...(process.platform === 'darwin' ? { select: 'Control+Shift+T', toggle: 'Control+Shift+Space', panic: 'Control+Shift+X' } : { select: 'Ctrl+Shift+T', toggle: 'Ctrl+Shift+Space', panic: 'Ctrl+Shift+X' }) },
      displays: screen.getAllDisplays().map(d => ({ id: d.id, label: d.label || d.size.width + ' × ' + d.size.height })),
      contentProtection: state.captureHidden !== false,
      captureForcedOff: Boolean(process.env.JARVIS_NO_PROTECT || process.env.KAASHIFY_NO_PROTECT),
      usage: companion.usage ? companion.usage(1) : null,
      transcription: state.voice,
      voice: companion.voiceStatus ? companion.voiceStatus() : null,
      speech: companion.speechStatus ? companion.speechStatus() : null,
      assignmentSpend: solveBudget.summary(process.env.KAASHIFY_ASSIGNMENT_BUDGET_FILE || path.join(userData, 'companion', 'assignment-budget.json')),
    };
  });
  handle('home:settings:get', publicSettings);
  handle('home:settings:set', settingsPatch);
  // Share my week: the picture the dashboard drew, to the clipboard and to
  // Pictures\Kaashify. Only a PNG data URL is accepted; nothing is uploaded.
  handle('home:share-card', dataUrl => {
    const url = String(dataUrl || '');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url) || url.length > 12e6) return { ok: false };
    const { clipboard, nativeImage } = require('electron');
    const img = nativeImage.createFromDataURL(url);
    if (img.isEmpty()) return { ok: false };
    clipboard.writeImage(img);
    let file = '';
    try { const dir = path.join(app.getPath('pictures'), 'Kaashify'); fs.mkdirSync(dir, { recursive: true }); file = path.join(dir, 'my-week-' + new Date().toISOString().slice(0, 10) + '.png'); fs.writeFileSync(file, img.toPNG()); } catch (_) { file = ''; }
    return { ok: true, file };
  });
  handle('home:my-kaashify', () => companion.myKaashify());
  handle('home:keys:test', which => testKeys(String(which || '')));
  handle('home:models:test', testModel);
  // The tour (companion/src/tour.js): where it stands, start it, or skip it for good.
  handle('home:tasks:list', () => companion.tasksHome());
  handle('home:task:action', p => companion.taskAction(p));
  handle('home:project:continue', id => companion.projectContinue(id));
  handle('home:knot:word', () => companion.knotWord());
  handle('home:tour:state', () => companion.tourState());
  handle('home:tour:start', () => { companion.startTour('home'); return companion.tourState(); });
  handle('home:tour:skip', () => { api.setPreference('tour_done', true); return companion.tourState(); });
  handle('home:sessions', () => api.listCompanionSessions());
  handle('home:messages', id => api.listCompanionMessages(Number(id)));
  handle('home:search', q => api.searchCompanionMessages(String(q || '').trim().slice(0,500)));
  handle('home:session:export', async id => {
    const session = api.listCompanionSessions().find(s => s.id === Number(id));
    if (!session) throw new Error('Session not found.');
    const picked = await dialog.showOpenDialog(home, { properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const root = fs.realpathSync(picked.filePaths[0]);
    const file = path.resolve(root, 'kaashify-session-' + session.id + '-' + Date.now() + '.md');
    if (!inside(root, file) || path.dirname(file) !== root) throw new Error('Export is outside the chosen folder.');
    const text = '# ' + (session.title || 'Kaashify session') + '\n\n' + session.started_at + '\n\n' + api.listCompanionMessages(session.id).map(m => '**' + m.channel + '** (' + m.ts + ')\n\n' + m.text).join('\n\n');
    fs.writeFileSync(file, text + '\n', { encoding: 'utf8', flag: 'wx' });
    return { ok: true, path: file };
  });
  handle('home:keeps:list', () => companion.keeps());
  handle('home:keeps:forget', key => { companion.forgetKeep(String(key)); return companion.keeps(); });
  handle('home:tasks:delete', () => companion.deleteTaskData());
  // What Kaashify knows about the person: list, add, drop, paste-import (src/memory.js).
  handle('home:memory:panel', () => companion.memoryPanel());
  handle('home:memory:add', (key, value) => { companion.memoryAdd(String(key || 'note').slice(0, 40), String(value || '').slice(0, 500)); return companion.memoryPanel(); });
  handle('home:memory:remove', id => { companion.memoryRemove(String(id || '')); return companion.memoryPanel(); });
  handle('home:memory:import', (source, text) => { if (!['chatgpt', 'claude', 'gemini', 'ai'].includes(source)) throw new Error('Unknown source.'); companion.memoryImport(source, String(text || '').slice(0, 40000)); return companion.memoryPanel(); });
  handle('home:memory:forget-source', source => { companion.memoryForgetSource(String(source || '')); return companion.memoryPanel(); });
  handle('home:memory:prompt', () => companion.memoryPrompt());
  // Layer 1 memory (companion/src/recall): the notes folder, imported AI chats,
  // and forgetting them. Files are only ever picked by the person here.
  handle('home:recall:panel', () => companion.recallPanel());
  handle('home:recall:vault', async () => { const picked = await dialog.showOpenDialog(home, { title: 'Choose your notes folder', properties: ['openDirectory'] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : companion.recallSetVault(fs.realpathSync(picked.filePaths[0])); });
  handle('home:recall:vault-clear', () => companion.recallSetVault(''));
  handle('home:recall:import-folder', () => companion.recallImportFolder());
  handle('home:recall:import-file', async () => { const picked = await dialog.showOpenDialog(home, { title: 'Import an export (ChatGPT, Claude, Google Takeout, Apple Notes)', properties: ['openFile'], filters: [{ name: 'Export', extensions: ['zip', 'json', 'md'] }] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : companion.recallImportFile(picked.filePaths[0]); });
  handle('home:recall:topics', () => companion.recallTopics());
  handle('home:recall:watch', on => companion.recallSetWatch({ watchImports: Boolean(on) }));
  handle('home:recall:watch-folder', async clear => { if (clear) return companion.recallSetWatch({ watchFolder: '' }); const picked = await dialog.showOpenDialog(home, { title: 'Also watch this folder for exports', properties: ['openDirectory'] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : companion.recallSetWatch({ watchFolder: fs.realpathSync(picked.filePaths[0]) }); });
  handle('home:recall:forget', () => companion.recallForgetChats());
  // Kaashify's own voice: where it stands, and the one-time model download.
  handle('home:voice:status', () => companion.voiceStatus());
  handle('home:voice:install', name => companion.voiceInstall(String(name || 'fable')));
  // Parakeet, the optional speech model: where it stands, and its one-time download.
  handle('home:speech:status', () => companion.speechStatus());
  handle('home:speech:install', () => companion.speechInstall());
  // Activity: the last 50 model requests from the usage ledger, in plain words.
  handle('home:activity', () => companion.activity());
  // Reminders and timers set by voice ("remind me at 4 to ..."): list and remove.
  handle('home:reminders:list', () => companion.reminders());
  handle('home:reminders:remove', id => companion.reminderRemove(String(id || '')));
  handle('home:routines:list', () => routines.load(routinesFile));
  handle('home:routines:delete', savedAt => {
    const rows = routines.load(routinesFile).filter(r => r.savedAt !== savedAt);
    fs.writeFileSync(routinesFile + '.tmp', JSON.stringify({ routines: rows }, null, 2));
    fs.renameSync(routinesFile + '.tmp', routinesFile); return rows;
  });
  handle('home:notes:list', notes);
  handle('home:folders:list', () => folders.list().map(f => ({ ...f, topFiles: folders.files(f.id) })));
  handle('home:folders:add', async () => { const picked = await dialog.showOpenDialog(home, { properties: ['openDirectory'] }); return picked.canceled || !picked.filePaths[0] ? { canceled: true } : folders.add(picked.filePaths[0]); });
  handle('home:folders:remove', id => folders.remove(String(id)));
  handle('home:folders:toggle', (id, enabled) => folders.toggle(String(id), enabled));
  handle('home:folders:reindex', id => folders.reindex(String(id)));
  handle('home:intents', () => INTENTS);
  handle('home:ptt:set', value => companion.setPttShortcut(value));
  handle('home:open-external', url => {
    if (!ALLOWED_EXTERNAL.has(url)) throw new Error('Link is not allowed.');
    return shell.openExternal(url);
  });
  handle('home:map:get', () => { const p = api.getPreferences(); return { layout: p.companion_map_layout || {}, viewport: p.companion_map_viewport || null }; });
  handle('home:map:set', (key, value) => {
    if (!['companion_map_layout','companion_map_viewport'].includes(key) || !value || typeof value !== 'object' || JSON.stringify(value).length > 150000) throw new Error('Invalid map preference.');
    const finite = v => Number.isFinite(v) && Math.abs(v) <= 100000;
    if (key.endsWith('viewport') ? !(finite(value.offsetX) && finite(value.offsetY) && value.scale >= .2 && value.scale <= 2) : !Object.values(value).every(p => p && finite(p.x) && finite(p.y))) throw new Error('Invalid map coordinates.');
    api.setPreference(key, value); return { ok: true };
  });
  handle('home:control', action => {
    const actions = { show: () => companion.show(), hide: () => companion.hide(), tutorial: () => companion.startTour() };
    // "Move overlay to" a corner: it travels there and remembers the spot.
    for (const corner of ['tl', 'tr', 'bl', 'br']) actions['move-' + corner] = () => { companion.moveKnot({ corner }); return companion.status(); };
    if (!actions[action]) throw new Error('Unknown control.'); return actions[action]();
  });
}
const guardQuit = createQuitGuard({ flush: () => databaseReady ? api.flushPersist() : { ok: true },
  ask: async outcome => { const result = await dialog.showMessageBox({ type: 'warning', title: 'Kaashify could not save', message: 'Your latest changes have not been saved.', detail: outcome.message || 'Keep the app open and check available disk space.', buttons: ['Keep open','Quit without saving'], defaultId: 0, cancelId: 0 }); return result.response === 1 ? 'quit_without_saving' : 'stay'; },
  retryQuit: () => setImmediate(() => app.quit()) });
// Proctored exams: say it once, then close. The box is not waited on because
// a lockdown browser can cover it; the quit happens either way.
function standDown(name) {
  console.log('[kaashify] ' + name + ' is open, standing down');
  try { companion?.hide(); companion?.unregisterShortcuts(); } catch {}
  dialog.showMessageBox({ type: 'info', buttons: ['OK'], ...EXAM_MESSAGE }).then(() => app.quit(), () => app.quit());
  setTimeout(() => app.quit(), 8000);
}
const examGuard = createExamGuard({ onExam: standDown });
app.on('before-quit', event => { if (companion?.isCapturing()) companion.setCapturing(false); guardQuit(event); });
app.on('will-quit', () => companion?.unregisterShortcuts());
app.on('window-all-closed', () => {});
app.on('activate', () => { if (databaseReady) openHome(); });
app.whenReady().then(async () => {
  const exam = await examGuard.check();
  if (exam) { standDown(exam); return; }
  // Warm the bundled voice while the app opens.
  if (!SMOKE) {
    try {
      const { createVoice } = require('../companion/src/voice');
      global.__kaashifyVoice = createVoice({ userData, settings: { get: () => store.getSettings() }, log: (m) => console.log('[voice]', m) });
      const st = global.__kaashifyVoice.status();
      console.log('[voice] at start: ' + st.voice + (st.installed ? ', on disk at ' + global.__kaashifyVoice.modelDir() : ', not on disk'));
      if (st.installed && st.voice !== 'system') { const t0 = Date.now(); global.__kaashifyVoice.warm().then(() => console.log('[voice] Fable loaded ' + (Date.now() - t0) + ' ms after start, ready ' + global.__kaashifyVoice.status().ready)); }
    } catch (e) { console.log('[voice] at start: ' + e.message); }
  }
  if (WINDOWS) examGuard.watch();
  await open(path.join(userData, 'data'));
  databaseReady = true;
  secrets.init(userData); sttLocal.init({ userData });
  folders = createFolders({ api, onProgress: value => send('home:indexing', value) });
  companion = companionApp.initCompanion({ standalone: true, desktopComplete: (p,o) => ai.complete(p, require('../companion/src/computer-words').paramsWithComputer(o || {})), desktopWarm: o => ai.warm(o),
    audioRoot: () => path.join(userData,'companion','audio'), showDesktop: openHome,
    isTrustedHome: contents => !!contents && !!home && !home.isDestroyed()
      && contents === home.webContents && contents.getURL() === pathToFileURL(homeFile).href,
    showFeedback: () => { const w = openHome(); const go = () => send('home:view', { view: 'feedback' }); if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go(); },
    showMyKaashify: () => { const w = openHome(); const go = () => send('home:view', { view: 'my-kaashify' }); if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go(); },
    showSettings: section => { const w = openHome(); const go = () => send('home:view', { view: 'settings', section: String(section || '') }); if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go(); },
    onCapturePolicy: () => { /* the dashboard stays visible to shares; Kaashify alone follows the switch */ },
    onVoiceState: s => send('home:voice', s),
    onSpeechState: s => send('home:speech', s),
    onReminders: rows => send('home:reminders', rows),
    onRecall: panel => send('home:recall', panel),
    onStateChange: s => send('home:state',s), getDesktopState: lifestyleSnapshot, folderContext: q => folders.context(q),
    // The dashboard's live view: a setting changed anywhere, a task moved, the pill's word.
    onSettingsChanged: () => send('home:settings', publicSettings()),
    onTaskEvent: p => send('home:tasks', p),
    onKnotWord: w => send('home:knot', w),
    autostart: { enabled: () => store.getSettings().startWithWindows === true, set: on => settingsPatch({ startWithWindows: !!on }) },
    // The tour (companion/src/tour.js): its preferences, its state for Home, and
    // the Home window's own Settings button for the guide demo with no AI set up.
    tourPrefs: { get: () => api.getPreferences(), set: (k, v) => api.setPreference(k, v) },
    onTourState: s => send('home:tour', s),
    tourHomeTarget: async () => {
      const w = openHome();
      if (w.webContents.isLoading()) await new Promise(r => w.webContents.once('did-finish-load', r));
      await new Promise(r => setTimeout(r, 400));
      const r = await w.webContents.executeJavaScript('(() => { const q = s => { const b = document.querySelector(s); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }; return { button: q("nav button[data-view=\\"settings\\"]"), rail: q("aside.rail") }; })()', true);
      if (!r || !r.button) return null;
      const cb = w.getContentBounds(), off = o => ({ x: cb.x + o.x, y: cb.y + o.y, w: o.w, h: o.h });
      return { button: off(r.button), rail: off(r.rail || r.button) };
    },
    // Card 7: who answers, as this process knows it (Claude Code on the path,
    // or a saved key that createLLM accepts), and the same one-word key check
    // the dashboard's Keys card runs.
    tourAi: async () => ({ cli: !!(await ai.status()).cli, key: createLLM(store.getSettings()).ready }),
    tourTestKey: which => testKeys(String(which || '')),
    tourSaveKey: (kind, key) => settingsPatch({ apiKeys: { [kind]: String(key || '') } }),
    // Card 10: the dashboard on the far side of the screen from Kaashify, and
    // where its rail buttons are, in screen pixels, so Kaashify can point.
    tourDashboard: async ({ side, narrow, views } = {}) => {
      const w = openHome();
      const area = screen.getDisplayMatching(w.getBounds()).workArea;
      const width = narrow ? 800 : Math.max(800, Math.min(1100, area.width - 520)), height = Math.max(560, Math.min(720, area.height - 80));
      const x = side === 'right' ? area.x + area.width - width - 24 : area.x + 24, y = area.y + Math.max(0, Math.round((area.height - height) / 2));
      w.setBounds({ x, y, width, height });
      if (w.webContents.isLoading()) await new Promise(r => w.webContents.once('did-finish-load', r));
      await new Promise(r => setTimeout(r, 450));
      const names = Array.isArray(views) && views.length ? views : ['saved', 'map', 'folders', 'settings'];
      const r = await w.webContents.executeJavaScript('(' + ((list) => { const q = (s) => { const b = document.querySelector(s); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }; const out = {}; for (const v of list) out[v] = q('nav button[data-view="' + v + '"]'); return { targets: out, rail: q('aside.rail') }; }).toString() + ')(' + JSON.stringify(names) + ')', true);
      if (!r || !r.targets) return null;
      const cb = w.getContentBounds(), off = o => (o ? { x: cb.x + o.x, y: cb.y + o.y, w: o.w, h: o.h } : null);
      const targets = {}; for (const [k, v] of Object.entries(r.targets)) if (v) targets[k] = off(v);
      return { targets, rail: off(r.rail) };
    },
    onSessionStart: meta => store.getSettings().persistTranscripts === false ? null : api.addCompanionSession(meta),
    onSessionEnd: (id,meta) => { const first = api.listCompanionMessages(id)[0]; api.updateCompanionSession(id, { ended_at: meta.ended_at, audio_path: meta.audio_path || '', title: first ? first.text.slice(0,80) : 'Silent session' }); api.flushPersist(); send('home:state', companion.status()); },
    onMessage: (id,turn) => { if (store.getSettings().persistTranscripts !== false) api.addCompanionMessage(id,turn); send('home:state',companion.status()); } });
  adoptLegacyAnthropicKey();
  registerHomeIpc();
  setSaveStateListener(s => send('home:save-state', s));
  // The first launch opens Home, and so does every launch until Get started is
  // done or skipped.
  // Started by Windows at sign-in: quietly, just Kaashify, unless the tour is still owed.
  const atLogin = process.argv.includes('--autostart');
  const firstRun = !atLogin && !api.getPreferences().home_seen;
  if ((!atLogin && !api.getPreferences().home_seen) || tourMod.shouldShow(api.getPreferences()) || SMOKE) openHome();
  // The first run: Kaashify types its hello into Notepad, then asks to show more (companion/src/hello.js).
  // KAASHIFY_HELLO=0 turns it off for scripted checks and benches that start a fresh profile.
  if (firstRun && !SMOKE && process.env.KAASHIFY_HELLO !== '0') setTimeout(() => { try { companion.helloFirstRun(); } catch (e) { console.log('[hello] ' + e.message); } }, 4000);
  // A chosen start-with-Windows is written again at each start, so it stays as
  // set and follows the exe if an update moved it (Clicky 1.0.50 had to fix exactly this).
  // The second item older versions left under Electron's default name goes at every start, chosen or not.
  if (!SMOKE && typeof store.getSettings().startWithWindows === 'boolean') applyAutostart(store.getSettings().startWithWindows);
  else if (!SMOKE) autostart.cleanup();
  if (SMOKE && process.env.KAASHIFY_HANDS_SMOKE) {
    // Hands smoke: the agent builds and one screen read comes back. It never acts.
    setTimeout(() => companion.handsCheck().then(r => console.log('[kaashify] hands smoke ' + JSON.stringify(r))).catch(e => console.log('[kaashify] hands smoke FAILED: ' + e.message)).finally(() => app.quit()), Number(process.env.KAASHIFY_HANDS_SMOKE_MS) || 5000);
  } else if (SMOKE) { console.log('[kaashify] smoke ok: overlay up, home up'); setTimeout(() => app.quit(),1600); }
}).catch(error => { console.error('[kaashify] startup failed:',error.message); app.exit(1); });
