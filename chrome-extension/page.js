'use strict';

const PRIVATE = /password|passcode|otp|one.?time|credit.card|card.number|cvv|security.code|social.security|identity.number|routing.number|bank.account|secret|recovery.code/i;
const FINAL = /\b(send|submit|delete|remove|discard|publish|post|pay|buy|purchase|order|checkout|transfer|authorize|approve|install|download|unsubscribe|sign in|log in|sign out|log out)\b/i;
const SAFE_BUTTON = /^(search|show( more| results)?|view( details| results)?|expand|collapse|filters?|sort( by)?|menu|open navigation|previous|previous page|next page)$/i;
const CONTROL = 'a[href], button, input, textarea, select, [contenteditable=true], [role=button], [role=checkbox], [role=radio], [role=tab]';
let snapshot;

function label(el) {
  const aria = el.getAttribute('aria-label');
  const editable = el.isContentEditable;
  const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
  return String(aria || labelled || (el.labels && Array.from(el.labels).map(l => l.innerText).join(' ')) ||
    el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (!editable && el.innerText) || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function visible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === 'visible' &&
    !el.closest('[hidden],[inert],[aria-hidden=true]');
}
function privateField(el, name) {
  return PRIVATE.test([name, el.name, el.id, el.autocomplete, el.type].join(' ')) ||
    ['password', 'file', 'hidden'].includes(el.type) || String(el.autocomplete || '').startsWith('cc-');
}
function protectedPage() {
  const host = location.hostname;
  return /^(mail\.google\.com|outlook\.(live|office|office365)\.com|outlook\.cloud\.microsoft|forms\.(office|cloud\.microsoft)\.com|accounts\.google\.com|login\..+)$/.test(host) ||
    (host === 'docs.google.com' && location.pathname.startsWith('/forms/')) ||
    /^(forms\.office\.com|forms\.cloud\.microsoft|forms\.gle)$/.test(host) ||
    !!document.querySelector('input[type=password]');
}
function control(el) {
  if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
  const name = label(el);
  if (privateField(el, name)) return null;
  const role = el.getAttribute('role');
  const href = el instanceof HTMLAnchorElement ? el.href : '';
  const field = el.matches('select, textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], [contenteditable=true]');
  const choice = ['checkbox', 'radio'].includes(el.type) || ['checkbox', 'radio', 'tab'].includes(role);
  const searchForm = !!(el.form && (el.form.getAttribute('method') || 'get').toLowerCase() === 'get' &&
    el.form.querySelector('input[type=search],input[name=q],[role=searchbox]') && /^search$/i.test(name));
  const anchor = href && /^(https?:)/i.test(href) && !el.hasAttribute('download');
  const safeButton = !el.form && SAFE_BUTTON.test(name);
  const click = !!(!FINAL.test(name) && (anchor || choice || safeButton || searchForm));
  if (!field && !click) return null;
  const options = el instanceof HTMLSelectElement && !el.multiple
    ? Array.from(el.options).filter(option => !option.disabled).slice(0, 15).map(option => option.label.slice(0, 60))
    : [];
  return { name: name || (field ? 'Text field' : 'Option'), type: field ? 'Edit' : anchor ? 'Link' : 'Button', click, fill: field && !el.readOnly, href, options };
}

function observe() {
  if (protectedPage()) return { ok: false, reason: 'protected' };
  const nodes = new Map();
  const controls = [];
  let controlBytes = 0;
  for (const el of document.querySelectorAll(CONTROL)) {
    const item = control(el);
    if (!item) continue;
    const id = controls.length + 10001;
    const info = { ...item, href: item.href.slice(0, 300), id };
    controlBytes += new TextEncoder().encode(JSON.stringify(info)).length;
    if (controlBytes > 70000) break;
    nodes.set(id, { el, item });
    controls.push(info);
    if (controls.length >= 100) break;
  }
  snapshot = { id: Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join(''), nodes, url: location.href };
  const root = document.querySelector('main,[role=main]') || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let copy = '';
  for (let visited = 0; visited < 1600 && copy.length < 4500; visited++) {
    const node = walker.nextNode();
    if (!node) break;
    const el = node.parentElement;
    if (el && !el.closest('script, style, textarea, input, [contenteditable], [role=textbox]') && visible(el)) {
      copy += ' ' + node.textContent.slice(0, 5000);
    }
  }
  return { ok: true, snapshot: snapshot.id, title: document.title.slice(0, 160), controls,
    text: copy.replace(/\s+/g, ' ').trim().slice(0, 4500) };
}

function act(message) {
  const { kind, control: id, deadline, text } = message;
  if (protectedPage()) return { ok: false, reason: 'protected' };
  if (!snapshot || message.snapshot !== snapshot.id || location.href !== snapshot.url ||
      document.visibilityState !== 'visible' || !document.hasFocus() || Date.now() > deadline) return { ok: false, reason: 'target-changed' };
  if (kind === 'scroll') {
    window.scrollBy(0, Math.round(window.innerHeight * (message.direction === 'up' ? -0.8 : 0.8)));
    snapshot = null;
    return { ok: true };
  }
  const entry = snapshot.nodes.get(id);
  const el = entry?.el;
  const current = el?.isConnected && control(el);
  if (!current || JSON.stringify(current) !== JSON.stringify(entry.item)) return { ok: false, reason: 'target-changed' };
  snapshot = null;
  if (kind === 'click' && current.click) {
    el.click();
    return { ok: true };
  }
  if (kind === 'fill' && current.fill && typeof text === 'string' && text.length <= 5000) {
    let expected = text;
    if (el instanceof HTMLSelectElement) {
      if (message.append || el.multiple) return { ok: false, reason: 'unsupported' };
      const matching = Array.from(el.options).filter(option => !option.disabled && option.label === text);
      if (matching.length !== 1) return { ok: false, reason: 'unsupported' };
      expected = matching[0].value;
      el.value = expected;
    } else {
      if (message.append) expected = (el.isContentEditable ? el.textContent : el.value) + text;
      if (expected.length > 5000) return { ok: false, reason: 'unsupported' };
      if (el.isContentEditable) el.textContent = expected;
      else {
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, expected);
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const value = el.isContentEditable ? el.textContent : el.value;
    return { ok: value === expected, reason: value === expected ? undefined : 'unverified' };
  }
  return { ok: false, reason: 'unsupported' };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof message?.kind !== 'string') return;
    if (message.kind === 'observe') reply(observe());
    else if (['click', 'fill', 'scroll'].includes(message.kind)) reply(act(message));
  });
}
