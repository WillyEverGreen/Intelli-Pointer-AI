const crypto = require('node:crypto');
const settings = require('./settings');
const providers = require('./providers');
const secrets = require('./secrets');

// Model client: streams answers from the direct providers (providers.js). Runs
// in the main process so API keys never reach a renderer, and requests are not
// subject to CORS.

let active = null; // { reqId, controller }
const answerCache = new Map(); // text-only dictionary lookups, LRU-ish
const CACHE_MAX = 100;

// All selectable models: the direct providers the user configured.
async function listModels() {
  await secrets.whenLoaded();
  return { models: providers.listModels(), errors: [] };
}

function cancel(reqId) {
  if (active && (!reqId || active.reqId === reqId)) {
    active.controller.abort();
    active = null;
  }
}

function cacheKey(body) {
  return crypto.createHash('sha256').update(JSON.stringify([body.model, body.messages])).digest('hex');
}

// Streams one answer. onEvent(name, data) receives meta/delta/sources/done/error.
// Starting a new request cancels the previous one (it is obsolete).
async function ask({ reqId, body, cacheable }, onEvent) {
  cancel();
  const controller = new AbortController();
  active = { reqId, controller };
  const t0 = performance.now();
  const timings = { uploadBytes: 0, requestToHeadersMs: null, firstTokenMs: null, totalMs: null };

  const hasImages = body.messages.some((m) => m.images?.length);
  const key = cacheable && !hasImages ? cacheKey(body) : null;
  if (key && answerCache.has(key)) {
    const text = answerCache.get(key);
    onEvent('meta', { model: body.model, cached: true });
    onEvent('delta', { text });
    timings.firstTokenMs = timings.totalMs = Math.round(performance.now() - t0);
    onEvent('done', { cached: true, clientTimings: timings });
    active = null;
    return { outcome: 'cached', timings };
  }

  timings.uploadBytes = Buffer.byteLength(JSON.stringify(body));
  let fullText = '';
  let outcome = 'ok';

  try {
    fullText = await askDirect(body, controller.signal, timings, t0, onEvent);
    if (key && outcome === 'ok' && fullText) {
      answerCache.set(key, fullText);
      if (answerCache.size > CACHE_MAX) answerCache.delete(answerCache.keys().next().value);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      outcome = 'cancelled';
      onEvent('cancelled', {});
    } else {
      outcome = err.code || 'error';
      onEvent('error', { message: err.message, retryable: err.retryable ?? true, code: err.code });
    }
  } finally {
    if (active?.reqId === reqId) active = null;
  }
  timings.totalMs ??= Math.round(performance.now() - t0);
  return { outcome, timings };
}

// Provider (Gemini / Groq / local server): stream from the main process.
async function askDirect(body, signal, timings, t0, onEvent) {
  onEvent('meta', { model: body.model, direct: true });
  let text = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  for await (const ev of providers.stream({ modelId: body.model, messages: body.messages, webSearch: body.webSearch, signal })) {
    if (ev.type === 'delta') {
      if (timings.firstTokenMs === null) timings.firstTokenMs = Math.round(performance.now() - t0);
      text += ev.text;
      onEvent('delta', { text: ev.text });
    } else if (ev.type === 'sources') {
      onEvent('sources', { items: ev.items });
    } else if (ev.type === 'usage') {
      usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
    }
  }
  timings.totalMs = Math.round(performance.now() - t0);
  onEvent('done', { usage, clientTimings: timings });
  return text;
}

module.exports = { ask, cancel, listModels };
