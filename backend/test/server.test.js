import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Auth enforcement with Firebase configured: no/garbage tokens must be refused
// before any provider or quota code runs.
process.env.FIREBASE_PROJECT_ID = 'intellipointer-test';
process.env.GEMINI_API_KEY = 'test-key-not-used';

const { initFirebase } = await import('../src/firebase.js');
const { createApp } = await import('../src/server.js');

let server;
let base;

before(async () => {
  initFirebase();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('healthz is public', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('ask without token is 401', async () => {
  const r = await fetch(`${base}/v1/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'missing_token');
});

test('ask with forged token is 401', async () => {
  const r = await fetch(`${base}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' },
    body: '{}',
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'invalid_token');
});

test('models requires auth', async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.equal(r.status, 401);
});

test('security headers are set and x-powered-by is hidden', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(r.headers.get('x-content-type-options'));
});
