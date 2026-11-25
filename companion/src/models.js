'use strict';

const NVIDIA_VISION = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const DEFAULT_MODELS = Object.freeze({
  openai: Object.freeze({ fast: 'gpt-4o-mini', smart: 'gpt-4o' }),
  anthropic: Object.freeze({ fast: 'claude-haiku-4-5', smart: 'claude-sonnet-5' }),
  gemini: Object.freeze({ fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' }),
  nvidia: Object.freeze({ fast: NVIDIA_VISION, smart: NVIDIA_VISION }),
});
const MODEL_SLOTS = ['fast', 'smart', 'vision'];
const MODEL_ID = /^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i;

function isModelProvider(provider) {
  return typeof provider === 'string' && Object.hasOwn(DEFAULT_MODELS, provider);
}

function modelSettingsPatch(patch) {
  const clean = {};
  if (isModelProvider(patch?.provider)) clean.provider = patch.provider;
  for (const provider of Object.keys(DEFAULT_MODELS)) {
    const desired = patch?.models?.[provider];
    if (!desired || typeof desired !== 'object' || Array.isArray(desired)) continue;
    for (const slot of MODEL_SLOTS) {
      if (!Object.hasOwn(desired, slot) || typeof desired[slot] !== 'string') continue;
      const id = desired[slot].trim();
      if (id && !MODEL_ID.test(id)) throw new Error('Enter a valid model ID for ' + slot + '.');
      clean.models ??= {};
      clean.models[provider] ??= {};
      clean.models[provider][slot] = id || DEFAULT_MODELS[provider][slot] || '';
    }
  }
  return clean;
}

// Screen requests use their own model. The built-in tiers accept images even
// when the user chooses a text-only model for ordinary replies.
function selectModel(settings, provider, tier, { image = false, override } = {}) {
  const models = settings.models?.[provider];
  const builtIn = DEFAULT_MODELS[provider]?.[tier];
  if (image) return models?.vision || override || builtIn || models?.[tier];
  return override || models?.[tier] || builtIn;
}

module.exports = { DEFAULT_MODELS, MODEL_SLOTS, NVIDIA_VISION, isModelProvider, modelSettingsPatch, selectModel };
