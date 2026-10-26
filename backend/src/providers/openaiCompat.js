import { config } from '../config.js';
import { readSseData, upstreamFailure } from './sse.js';

// Any OpenAI-compatible Chat Completions endpoint (a 9Router instance,
// OpenRouter, Groq, a local Ollama, ...). Model capabilities are declared in
// OPENAI_COMPAT_MODELS because the API does not report them reliably.
export const openaiCompat = {
  id: 'openai',
  label: config.openaiCompat.label,
  enabled: () => Boolean(config.openaiCompat.baseUrl && config.openaiCompat.models.length),
  models: () =>
    config.openaiCompat.models.map((entry) => {
      const [id, ...flags] = entry.split(':');
      return { id, vision: flags.includes('vision'), streaming: true, webSearch: false };
    }),

  async *stream({ model, messages, systemPrompt, signal }) {
    const body = {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role,
          content: m.images.length
            ? [
                ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })),
                ...(m.text ? [{ type: 'text', text: m.text }] : []),
              ]
            : m.text,
        })),
      ],
    };

    const headers = { 'content-type': 'application/json' };
    if (config.openaiCompat.apiKey) headers.authorization = `Bearer ${config.openaiCompat.apiKey}`;
    const response = await fetch(`${config.openaiCompat.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await upstreamFailure(config.openaiCompat.label, response);

    for await (const data of readSseData(response)) {
      if (data === '[DONE]') break;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text) yield { type: 'delta', text };
      if (chunk.usage) {
        yield { type: 'usage', inputTokens: chunk.usage.prompt_tokens || 0, outputTokens: chunk.usage.completion_tokens || 0 };
      }
    }
  },
};
