'use strict';

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const SAMPLE_RATE = 24000;
const MAX_BYTES = SAMPLE_RATE * 2 * 45;
const UNAVAILABLE = 'OpenAI voice is unavailable. Playing this reply locally.';

function createSpeechApi({ fetchAudio = globalThis.fetch } = {}) {
  const active = new Set();

  async function synthesize(text, apiKey) {
    if (!apiKey) return { error: 'Add an OpenAI key to use API voice.' };
    const input = String(text || '').trim().slice(0, 400);
    if (!input || active.size >= 2) return null;
    const controller = new AbortController();
    active.add(controller);
    const timeout = new Error('Speech request timed out.');
    const timer = setTimeout(() => controller.abort(timeout), 10000);
    try {
      const response = await fetchAudio(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'onyx', input, response_format: 'pcm' }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (controller.signal.aborted) return null;
      if (!response.ok) {
        const error = response.status === 401 || response.status === 403
          ? 'Check your OpenAI key and its speech permissions.'
          : UNAVAILABLE;
        return { error };
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > MAX_BYTES) throw new Error('Speech output is too long.');
        chunks.push(chunk);
      }
      if (controller.signal.aborted || length === 0 || length % 2 !== 0) return null;
      const pcm = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.byteLength; }
      return { sampleRate: SAMPLE_RATE, pcm: pcm.buffer };
    } catch (_) {
      return controller.signal.aborted && controller.signal.reason !== timeout ? null : { error: UNAVAILABLE };
    } finally {
      controller.abort();
      clearTimeout(timer);
      active.delete(controller);
    }
  }

  function stop() {
    for (const controller of active) controller.abort();
    active.clear();
  }

  return { synthesize, stop };
}

module.exports = { createSpeechApi };
