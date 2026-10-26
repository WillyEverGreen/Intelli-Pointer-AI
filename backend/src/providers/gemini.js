import { config } from '../config.js';
import { readSseData, upstreamFailure, UpstreamError } from './sse.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Google Gemini via the official Generative Language REST API (key from
// Google AI Studio). All configured Gemini models are multimodal and support
// Google Search grounding.
export const gemini = {
  id: 'gemini',
  label: 'Google Gemini',
  enabled: () => Boolean(config.gemini.apiKey),
  models: () => config.gemini.models.map((id) => ({ id, vision: true, streaming: true, webSearch: true })),

  async *stream({ model, messages, systemPrompt, webSearch, signal }) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          ...m.images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.data } })),
          ...(m.text ? [{ text: m.text }] : []),
        ],
      })),
      ...(webSearch ? { tools: [{ google_search: {} }] } : {}),
    };

    const response = await fetch(`${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await upstreamFailure('Gemini', response);

    const sources = new Map();
    let usage = null;
    for await (const data of readSseData(response)) {
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new UpstreamError(`Gemini error: ${chunk.error.message || 'unknown'}`);
      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        if (typeof part.text === 'string' && part.text && !part.thought) yield { type: 'delta', text: part.text };
      }
      for (const g of candidate?.groundingMetadata?.groundingChunks || []) {
        if (g.web?.uri) sources.set(g.web.uri, { url: g.web.uri, title: g.web.title || g.web.uri });
      }
      if (candidate?.finishReason === 'SAFETY') yield { type: 'delta', text: '\n\n_[Response stopped by the provider safety filter.]_' };
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount || 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount || 0,
        };
      }
    }
    if (sources.size) yield { type: 'sources', items: [...sources.values()] };
    if (usage) yield { type: 'usage', ...usage };
  },
};
