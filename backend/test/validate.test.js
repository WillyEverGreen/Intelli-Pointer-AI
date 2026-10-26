import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAskBody, sniffImageMime } from '../src/validate.js';

// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('accepts a text question', () => {
  const r = validateAskBody({ model: 'gemini/x', messages: [{ role: 'user', text: 'hi' }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.imageCount, 0);
});

test('accepts a real PNG', () => {
  const r = validateAskBody({ model: 'gemini/x', messages: [{ role: 'user', text: 'what', images: [{ mime: 'image/png', data: PNG }] }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.imageCount, 1);
});

test('rejects declared PNG whose bytes are not PNG', () => {
  const fake = Buffer.from('<svg onload=alert(1)>').toString('base64');
  const r = validateAskBody({ model: 'm', messages: [{ role: 'user', text: 'x', images: [{ mime: 'image/png', data: fake }] }] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 415);
});

test('rejects unsupported mime', () => {
  const r = validateAskBody({ model: 'm', messages: [{ role: 'user', text: 'x', images: [{ mime: 'image/svg+xml', data: PNG }] }] });
  assert.equal(r.status, 415);
});

test('rejects images in assistant turns and bad roles', () => {
  assert.equal(validateAskBody({ model: 'm', messages: [{ role: 'system', text: 'x' }] }).ok, false);
  const r = validateAskBody({
    model: 'm',
    messages: [{ role: 'assistant', text: 'a', images: [{ mime: 'image/png', data: PNG }] }, { role: 'user', text: 'q' }],
  });
  assert.equal(r.ok, false);
});

test('last message must be user', () => {
  const r = validateAskBody({ model: 'm', messages: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] });
  assert.equal(r.ok, false);
});

test('rejects oversized text', () => {
  const r = validateAskBody({ model: 'm', messages: [{ role: 'user', text: 'x'.repeat(20001) }] });
  assert.equal(r.status, 413);
});

test('sniffs jpeg and webp', () => {
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary')), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('GIF89a')), null);
});
