// Verifies a DEPLOYED IntelliPointer backend end to end and writes evidence
// for the project report (docs/evidence/deployment-<timestamp>.json + a
// Markdown table). Never prints tokens or passwords.
//
//   node scripts/verify-deployment.mjs --url https://your-api.onrender.com \
//        --firebase-key AIza... --email you@example.com --password '...' [--create]
//
// Environment alternatives: IP_URL, IP_FIREBASE_KEY, IP_EMAIL, IP_PASSWORD.
// --no-auth: local development backend started with AUTH_DISABLED=true
//            (skips the sign-in and the "must be rejected" checks).
// --model <id>: model to ask (default: the first model that reads images).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, env) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : process.env[env];
};

const url = (opt('url', 'IP_URL') || '').replace(/\/+$/, '');
const firebaseKey = opt('firebase-key', 'IP_FIREBASE_KEY');
const email = opt('email', 'IP_EMAIL');
const password = opt('password', 'IP_PASSWORD');
const noAuth = flag('no-auth');
const wantedModel = opt('model', 'IP_MODEL');

if (!url || (!noAuth && !(firebaseKey && email && password))) {
  console.error('Usage: node scripts/verify-deployment.mjs --url <https://...> --firebase-key <key> --email <e> --password <p> [--create] [--no-auth]');
  process.exit(2);
}

const results = [];
const record = (name, pass, detail = '', ms = null) => {
  results.push({ name, pass, detail, ms });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${ms != null ? ` (${ms} ms)` : ''}`);
};
const timed = async (fn) => {
  const t0 = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - t0)];
};
const json = (res) => res.json().catch(() => ({}));

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] || 'null'),
  }));
}

async function firebase(endpoint, body) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${encodeURIComponent(firebaseKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  return { ok: res.ok, body: await json(res) };
}

// A valid 1x1 PNG: enough to exercise the image path (type and size validation).
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// ---------- 1. availability and transport ----------
console.log(`\nVerifying ${url}\n`);
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
record('HTTPS is used', url.startsWith('https://') || isLocal, isLocal ? 'local development (HTTP allowed)' : url.split('/')[2]);

let health;
try {
  const [res, ms] = await timed(() => fetch(`${url}/healthz`, { signal: AbortSignal.timeout(120000) }));
  health = await json(res);
  record('GET /healthz responds (first request includes any cold start)', res.ok && health.ok === true, `providers=${health.providers} quota=${health.quota}`, ms);
  const [, warm] = await timed(() => fetch(`${url}/healthz`));
  record('Warm response time', warm < 1500, 'second request', warm);
} catch (err) {
  record('GET /healthz responds', false, err.message);
  process.exit(1);
}
record('Quotas are stored in Firestore', health.quota === 'firestore' || isLocal, isLocal && health.quota !== 'firestore' ? 'local development: in-memory quotas are expected' : health.quota);

const res = await fetch(`${url}/healthz`);
record('Security headers present (nosniff, HSTS; no x-powered-by)',
  Boolean(res.headers.get('x-content-type-options')) && (isLocal || Boolean(res.headers.get('strict-transport-security'))) && !res.headers.get('x-powered-by'));

// ---------- 2. authentication must be enforced ----------
if (!noAuth) {
  const post = (headers = {}, body = '{}') => fetch(`${url}/v1/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  record('POST /v1/ask without a token is rejected (401)', (await post()).status === 401);
  record('A forged token is rejected (401)', (await post({ authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' })).status === 401);
  record('GET /v1/models without a token is rejected (401)', (await fetch(`${url}/v1/models`)).status === 401);
}

// ---------- 3. sign in with Firebase ----------
let auth = {};
if (!noAuth) {
  let r = await firebase('signInWithPassword', { email, password });
  if (!r.ok && flag('create')) r = await firebase('signUp', { email, password });
  record('Firebase sign-in works', r.ok && Boolean(r.body.idToken), r.ok ? 'ID token issued' : r.body?.error?.message || 'failed');
  if (!r.ok) {
    summarize();
    process.exit(1);
  }
  auth = { authorization: `Bearer ${r.body.idToken}` };
}

// ---------- 4. models, streaming answer, usage ----------
const modelsRes = await fetch(`${url}/v1/models`, { headers: auth });
const { models = [] } = await json(modelsRes);
record('GET /v1/models lists models with capability flags', modelsRes.ok && models.length > 0, `${models.length} models, ${models.filter((m) => m.vision).length} read images`);
if (!models.length) {
  summarize();
  process.exit(1);
}
// Prefer a fast vision model so the latency numbers reflect the backend, not a slow model.
const fast = /lite|mini|fast|haiku|flash(?!.*pro)/i;
const model = models.find((m) => m.id === wantedModel)
  || models.find((m) => m.vision && /lite/i.test(m.id))
  || models.find((m) => m.vision && fast.test(m.id))
  || models.find((m) => m.vision) || models[0];

const usageBefore = await json(await fetch(`${url}/v1/usage`, { headers: auth }));
const t0 = performance.now();
const askRes = await fetch(`${url}/v1/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ model: model.id, messages: [{ role: 'user', text: 'Reply with one short sentence about clouds.' }] }),
});
let firstByte = null;
let firstDelta = null;
let text = '';
const reader = askRes.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  firstByte ??= Math.round(performance.now() - t0);
  const chunk = decoder.decode(value, { stream: true });
  if (firstDelta === null && chunk.includes('event: delta')) firstDelta = Math.round(performance.now() - t0);
  text += chunk;
}
const total = Math.round(performance.now() - t0);
const events = parseSse(text);
const names = events.map((e) => e.event);
const done = events.find((e) => e.event === 'done')?.data;
record(`POST /v1/ask streams an answer (${model.id})`, askRes.ok && names.includes('meta') && names.includes('delta') && Boolean(done),
  `${names.filter((n) => n === 'delta').length} chunks; first token ${firstDelta} ms, total ${total} ms; server: ${JSON.stringify(done?.timings)}`, total);
record('Answer is delivered as Server-Sent Events', /text\/event-stream/.test(askRes.headers.get('content-type') || ''));

if (!events.some((e) => e.event === 'error')) {
  const usageAfter = await json(await fetch(`${url}/v1/usage`, { headers: auth }));
  record('Usage counter incremented in Firestore', usageAfter.used === (usageBefore.used || 0) + 1, `used ${usageBefore.used} → ${usageAfter.used} of ${usageAfter.limit}`);
}

// ---------- 5. input validation ----------
if (model.vision) {
  const imageRes = await fetch(`${url}/v1/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', text: 'What colour is this?', images: [{ mime: 'image/png', data: TINY_PNG.toString('base64') }] }] }),
  });
  record('An image question is accepted by a vision model', imageRes.ok, `HTTP ${imageRes.status}`);
  await imageRes.text();
}
const fake = await fetch(`${url}/v1/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ model: model.id, messages: [{ role: 'user', text: 'x', images: [{ mime: 'image/png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') }] }] }),
});
record('A file that is not really a PNG is rejected (415)', fake.status === 415, `HTTP ${fake.status}`);
await fake.text();
const huge = await fetch(`${url}/v1/ask`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ model: model.id, messages: [{ role: 'user', text: 'a'.repeat(13 * 1024 * 1024) }] }),
});
record('An oversized request is rejected (413)', huge.status === 413, `HTTP ${huge.status}`);
await huge.text();

// ---------- summary ----------
function summarize() {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  const dir = path.join(process.cwd(), '..', 'docs', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `deployment-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ url, at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  const md = [`| # | Check | Result | Detail |`, '|---|---|---|---|', ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.pass ? 'PASS' : 'FAIL'} | ${(r.detail || '').replace(/\|/g, '/')} |`)].join('\n');
  fs.writeFileSync(file.replace('.json', '.md'), `# Deployment verification — ${url}\n\n${new Date().toISOString()}\n\n${md}\n`);
  console.log(`Evidence written to ${path.relative(process.cwd(), file)} (+ .md)`);
  if (passed !== results.length) process.exitCode = 1;
}
summarize();
