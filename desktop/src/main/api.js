const crypto = require('node:crypto');
const settings = require('./settings');
const auth = require('./auth');
const { createSseParser } = require('./sse');

// Client for the IntelliPointer cloud API. Runs in the main process so the
// auth token never reaches a renderer, and so requests are not subject to
// renderer CORS rules.

let active = null; // { reqId, controller }
const answerCache = new Map(); // text-only dictionary lookups, LRU-ish
const CACHE_MAX = 100;

class ApiError extends Error {
  constructor(message, { status = 0, code = 'error', retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function isLoopback(urlString) {
  const { hostname } = new URL(urlString);
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

async function authHeaders(forceRefresh) {
  try {
    return { authorization: `Bearer ${await auth.getIdToken({ forceRefresh })}` };
  } catch (err) {
    // A local dev backend may run with AUTH_DISABLED; let it decide.
    if (isLoopback(settings.get().backendUrl)) return {};
    throw new ApiError(err.message, { status: 401, code: 'not_signed_in' });
  }
}

async function request(pathname, init = {}, { retried = false } = {}) {
  const { backendUrl } = settings.get();
  let res;
  try {
    res = await fetch(`${backendUrl}${pathname}`, {
      ...init,
      headers: { ...(init.headers || {}), ...(await authHeaders(retried)) },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(`Cannot reach the backend at ${backendUrl}.`, { code: 'network', retryable: true });
  }
  if (res.ok) return res;

  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body.error === 'token_expired' && !retried) return request(pathname, init, { retried: true });
  throw new ApiError(body.message || `Backend returned HTTP ${res.status}.`, {
    status: res.status,
    code: body.error || 'http_error',
    retryable: res.status === 429 || res.status >= 500,
  });
}

async function listModels() {
  const res = await request('/v1/models');
  return (await res.json()).models;
}

async function usage() {
  const res = await request('/v1/usage');
  return res.json();
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

  const payload = JSON.stringify(body);
  timings.uploadBytes = Buffer.byteLength(payload);
  let fullText = '';
  let outcome = 'ok';
  let serverTimings = null;

  try {
    const res = await request('/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      signal: controller.signal,
    });
    timings.requestToHeadersMs = Math.round(performance.now() - t0);

    const parse = createSseParser((event, raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      if (event === 'delta') {
        if (timings.firstTokenMs === null) timings.firstTokenMs = Math.round(performance.now() - t0);
        fullText += data.text;
      }
      if (event === 'error') outcome = 'upstream_error';
      if (event === 'done') {
        serverTimings = data.timings;
        timings.totalMs = Math.round(performance.now() - t0);
        data = { ...data, clientTimings: timings };
      }
      onEvent(event, data);
    });

    const decoder = new TextDecoder();
    for await (const chunk of res.body) parse(decoder.decode(chunk, { stream: true }));
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
  return { outcome, timings, serverTimings };
}

module.exports = { ask, cancel, listModels, usage, ApiError };
