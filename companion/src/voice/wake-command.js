'use strict';

function wakeCommand(text) {
  const match = /^(?:hey|okay|ok)[\s,]+kaashify[\s,.:!?]+(.+)$/i.exec(String(text || '').trim());
  const command = match?.[1].trim() || '';
  return /[\p{L}\p{N}]/u.test(command) ? command : '';
}

module.exports = { wakeCommand };
