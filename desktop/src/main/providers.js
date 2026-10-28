const settings = require('./settings');
const secrets = require('./secrets');
const { createSseParser } = require('./sse');

// Direct ("bring your own key") model providers, called from the main
// process: Google Gemini, Groq, and any local OpenAI-compatible server
// (9Router, Ollama, LM Studio, ...). Same message shape as the cloud API:
// [{ role, text, images: [{ mime, data }] }].

const SYSTEM_PROMPT = [
  'You are IntelliPointer, an assistant that answers questions about content the user selected on their screen.',
  'Attached images are cropped screen regions, labelled in order as Region 1, Region 2, ... when there are several.',
  'If the user drew marks on an image (circles, arrows, highlights, pen strokes), the marked area is what they are asking about: focus on it and use the rest only as context. An image labelled "Marked area (zoomed)" is a close-up of that area.',
  'An image is always attached to the same message as these instructions. Never say that no image was attached unless the message really contains no image part; if you cannot read an image, say that instead.',
  'Text marked "OCR text" was extracted locally and may contain recognition errors; trust the image when they disagree.',
  'Be concise and direct. Use Markdown. Put code in fenced blocks with a language tag.',
].join(' ');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_BASE = 'https://api.groq.com/openai/v1';

const DEFS = {
  gemini: { label: 'Gemini', needsKey: true, webSearch: true },
  groq: { label: 'Groq', needsKey: true, webSearch: false },
  local: { label: 'Local', needsKey: false, webSearch: false },
};

// Best guess at image support from a model id; the user can override it.
const VISION_RE = /vision|llava|bakllava|[-_.]vl\b|[-_]vl[-_]|gpt-4o|gpt-4\.1|gpt-5|o3|o4|llama-4|gemma-?3|claude|gemini|pixtral|minicpm-v|moondream|qwen.*vl|internvl|mistral-small-3|mistral-medium|grok-.*vision/i;
const NON_CHAT_RE = /whisper|tts|embed|guard|moderation|rerank|playai|orpheus|transcri|image-generation|imagen|veo|lyria|aqa|learnlm|-live|native-audio|computer-use|robotics/i;

class ProviderError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function localBase() {
  const base = settings.get().providers.local.baseUrl;
  if (!base) throw new ProviderError('Set the local server URL in Settings → Models.');
  return base;
}

// `override` is an unsaved URL typed in Settings (for Load models / Test speed).
function openAiBase(provider, override) {
  if (provider === 'groq') return GROQ_BASE;
  const base = override || localBase();
  return settings.checkUrl(base, 'Local server URL', { allowLan: true }).href.replace(/\/+$/, '');
}

function providerLabel(provider) {
  return provider === 'local' ? settings.get().providers.local.label || 'Local' : DEFS[provider].label;
}

async function failure(provider, res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || '';
  } catch {
    /* not JSON */
  }
  const label = providerLabel(provider);
  const badKey = res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail));
  if (badKey) return new ProviderError(`${label} rejected the API key${detail ? `: ${detail.slice(0, 160)}` : '.'}`);
  if (res.status === 429) return new ProviderError(`${label} is rate limiting requests. Try again shortly.`, { retryable: true });
  return new ProviderError(`${label} returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, { retryable: res.status >= 500 });
}

async function call(provider, url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
    throw new ProviderError(`Cannot reach ${providerLabel(provider)} at ${new URL(url).origin}.`, { retryable: true });
  }
}

function keyFor(provider, override) {
  const key = override !== undefined && override !== '' ? override : secrets.get(provider);
  if (DEFS[provider].needsKey && !key) throw new ProviderError(`Add a ${DEFS[provider].label} API key in Settings → Models.`);
  return key;
}

// Lists the provider's chat models. `opts` may carry an unsaved key/baseUrl
// typed in Settings so the user can test before saving.
async function fetchModels(provider, opts = {}) {
  await secrets.whenLoaded();
  if (!DEFS[provider]) throw new ProviderError('Unknown provider.');
  const key = keyFor(provider, opts.apiKey);
  const signal = AbortSignal.timeout(15000);

  if (provider === 'gemini') {
    const res = await call(provider, `${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal });
    if (!res.ok) throw await failure(provider, res);
    const { models = [] } = await res.json();
    return models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini') && !NON_CHAT_RE.test(id) && !/-tts|-image/.test(id))
      .sort()
      .map((id) => ({ id, vision: true }));
  }

  const base = openAiBase(provider, opts.baseUrl);
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const res = await call(provider, `${base}/models`, { headers, signal });
  if (!res.ok) throw await failure(provider, res);
  const body = await res.json();
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return list
    .map((m) => (typeof m === 'string' ? { id: m } : { ...m, id: m.id || m.name }))
    .filter((m) => typeof m.id === 'string' && !NON_CHAT_RE.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      // Servers like 9Router report capabilities; trust them over the name guess.
      const caps = m.capabilities || {};
      const known = typeof caps.vision === 'boolean';
      return {
        id: m.id,
        vision: known ? caps.vision : VISION_RE.test(m.id),
        visionSource: known ? 'server' : 'guess',
        reasoning: Boolean(caps.reasoning || caps.thinking),
      };
    });
}

// Time to first token for one model with a tiny prompt (used by "Test speed").
async function speedTest(provider, model, opts = {}) {
  await secrets.whenLoaded();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const t0 = performance.now();
  try {
    const messages = [{ role: 'user', text: 'Reply with the single word OK.', images: [] }];
    for await (const ev of stream({ modelId: `${provider}:${model}`, messages, signal: controller.signal, override: opts })) {
      if (ev.type === 'delta') return { ok: true, firstTokenMs: Math.round(performance.now() - t0) };
    }
    return { ok: false, error: 'The model returned no text.' };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'No reply within 30 s.' : err.message };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// The user's chosen models for every configured direct provider.
function listModels() {
  const s = settings.get();
  const out = [];
  for (const provider of Object.keys(DEFS)) {
    const configured = provider === 'local' ? Boolean(s.providers.local.baseUrl) : Boolean(secrets.get(provider));
    if (!configured || s.providers[provider].enabled === false) continue;
    const group = providerLabel(provider);
    for (const m of s.providers[provider].models) {
      out.push({
        id: `${provider}:${m.id}`,
        label: `${group} · ${m.id}`,
        group: provider === 'local' ? `${group} (this network)` : `${group} (your key)`,
        vision: m.vision,
        latencyMs: m.latencyMs ?? null,
        webSearch: DEFS[provider].webSearch,
        direct: true,
        local: provider === 'local',
      });
    }
  }
  return out;
}

// Streams one answer. Yields { type: 'delta' | 'sources' | 'usage', ... }.
async function* stream({ modelId, messages, webSearch, signal, override = {} }) {
  await secrets.whenLoaded();
  const sep = modelId.indexOf(':');
  const provider = modelId.slice(0, sep);
  const model = modelId.slice(sep + 1);
  if (!DEFS[provider]) throw new ProviderError(`Unknown model ${modelId}.`);
  const key = keyFor(provider, override.apiKey);

  if (provider === 'gemini') {
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [...(m.images || []).map((img) => ({ inline_data: { mime_type: img.mime, data: img.data } })), ...(m.text ? [{ text: m.text }] : [])],
      })),
      ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
    };
    const res = await call(provider, `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await failure(provider, res);
    const sources = new Map();
    let usage = null;
    for await (const data of sseData(res)) {
      const chunk = JSON.parse(data);
      if (chunk.error) throw new ProviderError(`Gemini error: ${chunk.error.message || 'unknown'}`, { retryable: true });
      const cand = chunk.candidates?.[0];
      for (const part of cand?.content?.parts || []) {
        if (typeof part.text === 'string' && part.text && !part.thought) yield { type: 'delta', text: part.text };
      }
      for (const g of cand?.groundingMetadata?.groundingChunks || []) {
        if (g.web?.uri) sources.set(g.web.uri, { url: g.web.uri, title: g.web.title || g.web.uri });
      }
      if (cand?.finishReason === 'SAFETY') yield { type: 'delta', text: '\n\n_[Stopped by the provider safety filter.]_' };
      if (chunk.usageMetadata) usage = { inputTokens: chunk.usageMetadata.promptTokenCount || 0, outputTokens: chunk.usageMetadata.candidatesTokenCount || 0 };
    }
    if (sources.size) yield { type: 'sources', items: [...sources.values()] };
    if (usage) yield { type: 'usage', ...usage };
    return;
  }

  // Groq and local servers: OpenAI Chat Completions.
  const body = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.map((m) => ({
        role: m.role,
        content: m.images?.length
          ? [...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })), ...(m.text ? [{ type: 'text', text: m.text }] : [])]
          : m.text,
      })),
    ],
  };
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await call(provider, `${openAiBase(provider, override.baseUrl)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw await failure(provider, res);
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data);
    if (chunk.error) throw new ProviderError(`${providerLabel(provider)} error: ${chunk.error.message || 'unknown'}`, { retryable: true });
    const text = chunk.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) yield { type: 'delta', text };
    const u = chunk.usage || chunk.x_groq?.usage;
    if (u) yield { type: 'usage', inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 };
  }
}

// Yields each SSE `data:` payload of a fetch Response.
async function* sseData(res) {
  const queue = [];
  const parse = createSseParser((_event, data) => queue.push(data));
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    parse(decoder.decode(chunk, { stream: true }));
    while (queue.length) yield queue.shift();
  }
  parse('\n\n');
  while (queue.length) yield queue.shift();
}

module.exports = { fetchModels, listModels, stream, speedTest, ProviderError, DEFS, VISION_RE };
