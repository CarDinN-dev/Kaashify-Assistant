'use strict';

const { randomUUID } = require('node:crypto');
const { protectedKind } = require('../hands/workflows');

const CHROME = /^chrome(?:\.exe)?$/i;
const TEXT_LIMIT = 2400;
const NATIVE_INPUT = new Set(['click', 'type', 'press', 'drag', 'scroll']);
const CHROME_OPS = new Set(['read_page', 'new_tab', 'switch_tab']);

function isChrome(fg) { return CHROME.test(fg?.process || ''); }

function willUseChrome(request, fg) {
  const words = String(request || '');
  if (/^\s*(?:please\s+)?(?:open|launch|start)\s+(?!(?:google\s+)?chrome\b)/i.test(words) && !/\bchrome\b/i.test(words)) return false;
  return (isChrome(fg) || /\bchrome\b/i.test(words))
    && /\b(search|look up|find|read|summarize|type|browse|click|fill|open|tab|go to|visit|check)\b/i.test(words)
    && !/^\s*(?:please\s+)?(?:open|launch|start)\s+(?:google\s+)?chrome[.!\s]*$/i.test(words);
}

function makeBrowserActions({ bridge, foreground, refuseSite }) {
  async function inspect(fg, task) {
    if (!isChrome(fg) || !task || task.chromeFallback || (!task.chromeStarted && !willUseChrome(task.request, fg))) return null;
    if (!bridge.status().connected) return task.chromeStarted ? { blocked: 'browser-unavailable' } : null;
    task.chromeId ||= randomUUID();
    const result = await bridge.send({ kind: 'observe', task: task.chromeId, start: !task.chromeStarted }, { signal: task.controller?.signal });
    if (!result.ok) return { blocked: result.reason };
    task.chromeStarted = true;
    if (!result.target || typeof result.snapshot !== 'string' || !Array.isArray(result.controls)) return { blocked: 'browser-unavailable' };
    return {
      target: result.target, basic: result.basic === true, snapshot: result.snapshot,
      text: String(result.text || '').slice(0, TEXT_LIMIT),
      elements: result.controls.slice(0, 100).filter(c => Number.isSafeInteger(c?.id) && c.id >= 10001).map(c => ({
        id: c.id, name: String(c.name || '').slice(0, 120), type: c.type, href: String(c.href || '').slice(0, 300), chrome: true,
        options: Array.isArray(c.options) ? c.options.slice(0, 15).filter(v => typeof v === 'string').map(v => v.slice(0, 60)) : [],
      })),
      tabs: Array.isArray(result.tabs) ? result.tabs.filter(Number.isSafeInteger).slice(0, 8) : [],
    };
  }

  async function run(name, args, ctx) {
    const { chrome, task, fg } = ctx;
    if (!isChrome(fg) || !task || !chrome) return CHROME_OPS.has(name) ? { ok: false, report: 'This needs a connected Chrome tab.' } : null;
    if (!NATIVE_INPUT.has(name) && !CHROME_OPS.has(name) && !['open_url', 'web_search'].includes(name)) return null;
    if (['open_url', 'web_search'].includes(name) && args.in && !/\bchrome\b/i.test(args.in)) return null;
    if (chrome.blocked) {
      if (protectedKind(ctx) || chrome.blocked === 'protected') {
        if (NATIVE_INPUT.has(name) || CHROME_OPS.has(name)) return { ok: false, guarded: true, report: 'Finish this private page yourself, or ask Kaashify to prepare a supported draft or survey.' };
      }
      if (['target-changed', 'browser-unavailable'].includes(chrome.blocked)) {
        return { ok: false, guarded: true, report: 'Chrome changed or disconnected. Bring the task tab forward and ask again.' };
      }
      return null;
    }
    if (name === 'read_page') return chrome.text
      ? { ok: true, sourceData: chrome.text, report: 'Read the visible Chrome page.', noLook: true }
      : { ok: false, report: 'There is no readable text on this page.' };
    if (chrome.basic && !['open_url', 'web_search', 'new_tab', 'switch_tab'].includes(name)) {
      return { ok: false, report: 'Navigate from the new tab before using page controls.' };
    }
    const operation = { task: task.chromeId, target: chrome.target, snapshot: chrome.snapshot };
    if (name === 'click' || name === 'type') {
      if (args.submit || (args.button && args.button !== 'left') || args.double) return { ok: false, guarded: true, report: 'That browser action needs manual input. Chrome fields can be filled for you to review.' };
      const target = chrome.elements.find(el => el.id === args.id);
      if (!target?.chrome) return { ok: false, report: 'Choose a numbered control on the Chrome page.' };
      const refused = name === 'click' && target.href && refuseSite?.(target.href);
      if (refused) return { ok: false, guarded: true, report: refused };
      Object.assign(operation, { kind: name === 'type' ? 'fill' : 'click', control: target.id, append: args.append === true, text: name === 'type' ? String(args.text || '').slice(0, 5000) : undefined });
    } else if (name === 'scroll') {
      Object.assign(operation, { kind: 'scroll', direction: args.direction === 'up' ? 'up' : 'down' });
    } else if (name === 'switch_tab') {
      if (!chrome.tabs.includes(args.tab)) return { ok: false, report: 'That tab is outside this task.' };
      Object.assign(operation, { kind: 'switch-tab', tab: args.tab });
    } else if (['open_url', 'web_search', 'new_tab'].includes(name)) {
      const address = name === 'web_search' && args.query
        ? 'https://www.google.com/search?q=' + encodeURIComponent(String(args.query).slice(0, 300))
        : args.url;
      try {
        const url = new URL(address);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Unsupported URL');
        const refused = refuseSite?.(url.href);
        if (refused) return { ok: false, guarded: true, report: refused };
        Object.assign(operation, { kind: name === 'new_tab' ? 'open-tab' : 'navigate', url: url.href });
      } catch { return { ok: false, report: 'Use a complete HTTP or HTTPS address.' }; }
    } else {
      return { ok: false, guarded: true, report: 'That shortcut or gesture needs manual input in Chrome.' };
    }
    const current = await foreground();
    if (task.controller?.signal.aborted || fg.hwnd !== current?.hwnd || fg.pid !== current?.pid) {
      return { ok: false, guarded: true, report: 'The Chrome window changed. Nothing was entered.' };
    }
    const result = await bridge.send(operation, { signal: task.controller?.signal });
    if (!result.ok) return { ok: false, guarded: true, report: result.reason === 'protected' ? 'Continue on this private page yourself.'
      : result.reason === 'unverified' ? 'I could not verify the change. Review the Chrome field before trying again.'
        : 'I could not verify the Chrome control or tab. Check it before continuing.' };
    return { ok: true, report: name === 'type' ? 'Verified the text in the Chrome field.' : 'Chrome accepted the step. Check the updated page.',
      noLook: true, needsObservation: name !== 'type' };
  }

  return { inspect, run, cancel: task => bridge.cancel(task?.chromeId) };
}

module.exports = { makeBrowserActions, isChrome, willUseChrome };
