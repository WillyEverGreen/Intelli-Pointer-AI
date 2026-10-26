import { config } from './config.js';

// Validates and normalises the /v1/ask body.
// Shape: { model, messages: [{ role: 'user'|'assistant', text, images?: [{ mime, data }] }], webSearch? }
// Returns { ok: true, value } or { ok: false, status, error, message }.

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Checks the real file signature, not just the declared MIME type.
export function sniffImageMime(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function fail(message, status = 400, error = 'invalid_request') {
  return { ok: false, status, error, message };
}

export function validateAskBody(body) {
  const L = config.limits;
  if (!body || typeof body !== 'object') return fail('Body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model || body.model.length > 128) return fail('model is required.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) return fail('messages must be a non-empty array.');
  if (body.messages.length > L.maxMessages) return fail(`At most ${L.maxMessages} messages are allowed.`, 413, 'too_large');

  let imageCount = 0;
  const messages = [];
  for (const [i, m] of body.messages.entries()) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return fail(`messages[${i}].role must be user or assistant.`);
    const text = typeof m.text === 'string' ? m.text : '';
    if (text.length > L.maxTextChars) return fail(`messages[${i}].text exceeds ${L.maxTextChars} characters.`, 413, 'too_large');

    const images = [];
    if (m.images !== undefined) {
      if (!Array.isArray(m.images)) return fail(`messages[${i}].images must be an array.`);
      if (m.role !== 'user' && m.images.length) return fail('Only user messages may contain images.');
      for (const [j, img] of m.images.entries()) {
        if (!img || !ALLOWED_MIME.has(img.mime)) return fail(`messages[${i}].images[${j}] must be PNG, JPEG or WebP.`, 415, 'unsupported_media');
        if (typeof img.data !== 'string' || !BASE64_RE.test(img.data)) return fail(`messages[${i}].images[${j}].data must be base64.`);
        const buf = Buffer.from(img.data, 'base64');
        if (buf.length > L.maxImageBytes) return fail(`Image exceeds ${L.maxImageBytes} bytes.`, 413, 'too_large');
        if (sniffImageMime(buf) !== img.mime) return fail('Image content does not match its declared type.', 415, 'unsupported_media');
        images.push({ mime: img.mime, data: img.data });
        imageCount += 1;
      }
    }
    if (!text.trim() && images.length === 0) return fail(`messages[${i}] is empty.`);
    messages.push({ role: m.role, text, images });
  }

  if (imageCount > L.maxImagesPerRequest) return fail(`At most ${L.maxImagesPerRequest} images per request.`, 413, 'too_large');
  if (messages[messages.length - 1].role !== 'user') return fail('The last message must be from the user.');

  return {
    ok: true,
    value: { model: body.model, messages, webSearch: body.webSearch === true, imageCount },
  };
}
