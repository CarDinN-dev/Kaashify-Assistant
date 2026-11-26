'use strict';

const { workflowRequest } = require('./workflows');
const VERBS = '(?:open|launch|switch|go|search|look|find|read|check|take|put|copy|type|write|draft|edit|compose|prepare|fill|answer|summarize)';
const SEPARATOR = new RegExp('(?:[;,]\\s*|\\b(?:and\\s+then|then|and)\\s+)(?=' + VERBS + '\\b)', 'i');

function compoundRequest(text, installed = []) {
  const input = String(text || '').slice(0, 4000);
  const parts = input.split(SEPARATOR).map(x => x.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 10) return null;
  const names = ['Chrome', 'Edge', 'Firefox', 'Notepad', 'Word', 'Outlook', 'Gmail', 'Google Forms', 'Microsoft Forms',
    ...installed.map(x => x.name)].filter(x => typeof x === 'string' && x.length >= 3 && x.length <= 70);
  const mentioned = new Set();
  const workflows = [];
  for (const part of parts) {
    const masked = part.replace(/https?:\/\/\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+/gi, '');
    const lowercase = masked.toLowerCase();
    const matches = names.filter(name => {
      const key = name.toLowerCase();
      const index = lowercase.indexOf(key);
      return index >= 0 && !/\w/.test(lowercase[index - 1] || '') && !/\w/.test(lowercase[index + key.length] || '');
    });
    const longest = matches.sort((a, b) => b.length - a.length)[0];
    if (longest) mentioned.add(longest.toLowerCase().replace(/^(google |microsoft )/, ''));
    const request = part.replace(/^\b(?:put|copy)\b/i, 'Write');
    const spec = workflowRequest(request);
    if (spec) workflows.push({ id: workflows.length + 1, spec, request });
  }
  if (mentioned.size < 2) return null;
  return { apps: [...mentioned], workflows };
}

module.exports = { compoundRequest };
