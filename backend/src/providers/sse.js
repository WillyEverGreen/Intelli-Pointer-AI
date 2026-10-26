// Parses a fetch() Response body that uses Server-Sent Events and yields the
// `data:` payload of each event as a string.
export async function* readSseData(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trimStart();
}

export class UpstreamError extends Error {
  constructor(message, { status = 502, retryable = true } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

// Maps an upstream HTTP failure to a safe, non-leaky error.
export async function upstreamFailure(provider, response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || '';
  } catch {
    /* body was not JSON */
  }
  const status = response.status;
  const retryable = status === 429 || status >= 500;
  const message = status === 429
    ? `${provider} is rate limiting requests. Try again shortly.`
    : `${provider} returned HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  return new UpstreamError(message, { status: status === 429 ? 429 : 502, retryable });
}
