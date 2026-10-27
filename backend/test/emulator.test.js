// Integration test against the REAL Firebase Authentication and Cloud
// Firestore emulators (same code paths as production: ID-token verification,
// Firestore transactions, security rules). The AI provider is a local fake
// server, so no API key or billing is needed.
//
// Run: npm run test:emulator      (starts the emulators, runs this, stops them)
// Needs Java 21+ (for the Firestore emulator) and network on first run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-intellipointer';
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099'}`;
const FIRESTORE = `http://${process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085'}`;
const DAILY_LIMIT = 5;

let upstream;
let upstreamLog;
let server;
let base;
let firestore;
let config;
const logs = [];

function sseEvents(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

async function signUp(email) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery', returnSecureToken: true }),
  });
  const body = await res.json();
  assert.ok(body.idToken, `sign-up failed: ${JSON.stringify(body)}`);
  return { token: body.idToken, uid: body.localId };
}

const ask = (token, body, signal) => fetch(`${base}/v1/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
  signal,
});

const question = (model = 'openai/fake', text = 'hello') => ({ model, messages: [{ role: 'user', text }] });

before(async () => {
  // Fake OpenAI-compatible upstream.
  upstreamLog = { closed: 0, requests: 0 };
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      upstreamLog.requests += 1;
      const body = JSON.parse(raw || '{}');
      if (body.model === 'fail') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
      }
      res.setHeader('content-type', 'text/event-stream');
      const delta = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
      if (body.model === 'slow') {
        req.on('close', () => { upstreamLog.closed += 1; });
        res.on('close', () => { upstreamLog.closed += 1; });
        const timer = setInterval(() => res.write(delta('tick ')), 40);
        res.on('close', () => clearInterval(timer));
        return undefined;
      }
      res.write(delta('Hello '));
      res.write(delta('from '));
      res.write(delta('upstream.'));
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return undefined;
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    FIREBASE_PROJECT_ID: PROJECT,
    OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    OPENAI_COMPAT_LABEL: 'Fake',
    OPENAI_COMPAT_MODELS: 'fake:vision,textonly,slow:vision,fail:vision',
    DAILY_REQUEST_LIMIT: String(DAILY_LIMIT),
    RATE_LIMIT_PER_MINUTE: '1000',
    MAX_IMAGE_BYTES: '1024',
  });
  delete process.env.GEMINI_API_KEY;
  delete process.env.AUTH_DISABLED;

  // The server logs to console.log; collect it to check what is (not) logged.
  const original = console.log;
  console.log = (...a) => {
    logs.push(a.join(' '));
    original(...a);
  };

  ({ config } = await import('../src/config.js'));
  const { initFirebase } = await import('../src/firebase.js');
  const { createApp } = await import('../src/server.js');
  initFirebase();
  firestore = (await import('firebase-admin/firestore')).getFirestore();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  upstream?.close();
});

test('healthz reports Firestore-backed quotas', async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.quota, 'firestore');
});

test('requests without a valid Firebase ID token are rejected', async () => {
  assert.equal((await ask(null, question())).status, 401);
  assert.equal((await ask('not.a.token', question())).status, 401);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
});

test('a real emulator ID token is accepted and models are listed with capabilities', async () => {
  const { token } = await signUp('models@example.com');
  const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const { models } = await res.json();
  assert.deepEqual(models.map((m) => [m.id, m.vision]).sort(), [
    ['openai/fail', true], ['openai/fake', true], ['openai/slow', true], ['openai/textonly', false],
  ]);
});

test('/v1/ask streams SSE (meta, delta, done) and records usage in Firestore', async () => {
  const { token, uid } = await signUp('stream@example.com');
  const res = await ask(token, question());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = sseEvents(await res.text());
  assert.deepEqual(events.map((e) => e.event), ['meta', 'delta', 'delta', 'delta', 'done']);
  assert.equal(events.filter((e) => e.event === 'delta').map((e) => e.data.text).join(''), 'Hello from upstream.');
  const done = events.at(-1).data;
  assert.deepEqual(done.usage, { inputTokens: 11, outputTokens: 3 });
  assert.equal(typeof done.timings.firstTokenMs, 'number');

  await new Promise((r) => setTimeout(r, 300)); // usage is recorded after the stream ends
  const day = new Date().toISOString().slice(0, 10);
  const doc = (await firestore.collection('usage').doc(`${uid}_${day}`).get()).data();
  assert.equal(doc.requests, 1);
  assert.equal(doc.outputTokens, 3);
  assert.equal(doc.uid, uid);
  assert.deepEqual(Object.keys(doc).sort().filter((k) => !['updatedAt'].includes(k)),
    ['day', 'inputTokens', 'lastModel', 'lastProvider', 'outputTokens', 'requests', 'uid'].sort(),
    'only counters and ids are stored, never prompts or images');
});

test('the daily quota holds under a burst of concurrent requests (atomic transactions)', async () => {
  const { token, uid } = await signUp('burst@example.com');
  const results = await Promise.all(Array.from({ length: 12 }, () => ask(token, question()).then(async (r) => {
    await r.text();
    return r.status;
  })));
  assert.equal(results.filter((s) => s === 200).length, DAILY_LIMIT, `exactly ${DAILY_LIMIT} of 12 parallel requests allowed (${results.join(',')})`);
  assert.equal(results.filter((s) => s === 429).length, 12 - DAILY_LIMIT);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await firestore.collection('usage').doc(`${uid}_${day}`).get()).data().requests, DAILY_LIMIT, 'the counter never overshoots');
  const blocked = await (await ask(token, question())).json();
  assert.equal(blocked.error, 'quota_exceeded');
});

test("one user's quota does not affect another user's", async () => {
  const { token: other } = await signUp('other@example.com');
  const res = await ask(other, question());
  assert.equal(res.status, 200);
  await res.text();
  const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${other}` } })).json();
  assert.equal(usage.used, 1);
  assert.equal(usage.limit, DAILY_LIMIT);
  assert.equal(usage.backend, 'firestore');
});

test('revoked sessions and disabled accounts are rejected', async () => {
  const { getAuth } = await import('firebase-admin/auth');
  const usage = (token) => fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } });

  // Firebase revocation has one-second resolution: a token issued in the same
  // second as the revocation is not affected, so wait out the second first.
  const { token, uid } = await signUp('revoked@example.com');
  assert.equal((await usage(token)).status, 200);
  await new Promise((r) => setTimeout(r, 1100));
  await getAuth().revokeRefreshTokens(uid);
  assert.equal((await usage(token)).status, 401, 'revoked token refused at once');

  const second = await signUp('disabled@example.com');
  assert.equal((await usage(second.token)).status, 200);
  await getAuth().updateUser(second.uid, { disabled: true });
  assert.equal((await usage(second.token)).status, 401, 'disabled account refused at once');
});

test('input validation: image size, image on a text-only model, unknown model', async () => {
  const { token } = await signUp('validate@example.com');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const withImage = (model, data) => ({ model, messages: [{ role: 'user', text: 'x', images: [{ mime: 'image/png', data: data.toString('base64') }] }] });

  const textOnly = await ask(token, withImage('openai/textonly', png));
  assert.equal(textOnly.status, 400);
  assert.equal((await textOnly.json()).error, 'model_no_vision');

  const big = Buffer.concat([png, Buffer.alloc(2000)]); // valid PNG header, over the 1 KB test limit
  const tooBig = await ask(token, withImage('openai/fake', big));
  assert.equal(tooBig.status, 413);

  assert.equal((await ask(token, question('openai/does-not-exist'))).status, 400);
});

test('upstream failures surface as a retryable SSE error', async () => {
  const { token } = await signUp('fail@example.com');
  const events = sseEvents(await (await ask(token, question('openai/fail'))).text());
  const err = events.find((e) => e.event === 'error');
  assert.ok(err, 'error event sent');
  assert.match(err.data.message, /upstream exploded/);
});

test('a client that disconnects cancels the upstream request', async () => {
  const { token } = await signUp('abort@example.com');
  const controller = new AbortController();
  const res = await ask(token, question('openai/slow'), controller.signal);
  const reader = res.body.getReader();
  await reader.read(); // meta
  await reader.read(); // first tokens
  const before = upstreamLog.closed;
  controller.abort();
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(upstreamLog.closed > before, 'upstream connection was closed after the client left');
});

test('logs never contain prompts or tokens', async () => {
  const { token } = await signUp('logs@example.com');
  const secret = 'TOP-SECRET-PROMPT-8c1f';
  await (await ask(token, question('openai/fake', secret))).text();
  await new Promise((r) => setTimeout(r, 300));
  const all = logs.join('\n');
  assert.ok(all.includes('"msg":"ask"'), 'the request was logged');
  assert.ok(!all.includes(secret), 'prompt text is not logged');
  assert.ok(!all.includes(token.slice(0, 40)), 'tokens are not logged');
});

test('per-user rate limit returns 429 independent of the daily quota', async () => {
  const { createApp } = await import('../src/server.js');
  config.limits.requestsPerMinutePerUser = 3;
  config.limits.dailyRequestsPerUser = 1000;
  const limited = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => limited.once('listening', r));
  const url = `http://127.0.0.1:${limited.address().port}`;
  const { token } = await signUp('ratelimit@example.com');
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${url}/v1/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(question()),
    });
    await r.text();
    statuses.push(r.status);
  }
  limited.close();
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test('Firestore security rules deny every client read and write', async () => {
  const { token, uid } = await signUp('rules@example.com');
  const day = new Date().toISOString().slice(0, 10);
  const doc = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/usage/${uid}_${day}`;
  await firestore.collection('usage').doc(`${uid}_${day}`).set({ uid, requests: 1 });

  // Anonymous and signed-in clients are both refused...
  assert.equal((await fetch(doc)).status, 403, 'anonymous read denied');
  assert.equal((await fetch(doc, { headers: { authorization: `Bearer ${token}` } })).status, 403, "a user cannot read even their own usage document");
  const write = await fetch(doc, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { requests: { integerValue: '0' } } }),
  });
  assert.equal(write.status, 403, 'a user cannot reset their own quota');
  // ...while the backend's admin access (which bypasses rules) can read it.
  assert.equal((await fetch(doc, { headers: { authorization: 'Bearer owner' } })).status, 200);
});
