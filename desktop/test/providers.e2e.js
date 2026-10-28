// Live test of the direct ("your own key") providers, run in Electron so the
// encrypted key store works. Uses an isolated userData folder.
//   GEMINI_API_KEY=... npx electron test/providers.e2e.js [outDir]
//   (GROQ_API_KEY / LOCAL_BASE_URL also tested when set)
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const outDir = process.argv[2] || path.join(__dirname, '..', '.test-output');
app.setPath('userData', path.join(outDir, 'userData-providers'));

app.whenReady().then(async () => {
  const failures = [];
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
    if (!cond) failures.push(msg);
  };
  const settings = require('../src/main/settings');
  const secrets = require('../src/main/secrets');
  const providers = require('../src/main/providers');
  const api = require('../src/main/api');
  await secrets.load();

  // Settings validation
  let threw = false;
  try {
    settings.update({ providers: { local: { baseUrl: 'http://example.com/v1' } } });
  } catch {
    threw = true;
  }
  check(threw, 'plain-HTTP local server outside the local network is rejected');
  settings.update({ providers: { local: { baseUrl: 'http://192.168.1.20:11434/v1/' } } });
  check(settings.get().providers.local.baseUrl === 'http://192.168.1.20:11434/v1', 'LAN http URL accepted and normalised');
  settings.update({ providers: { local: { baseUrl: '' } } });

  // Key storage is encrypted at rest
  await secrets.set('groq', 'gsk_test_secret_value_1234');
  const raw = fs.readFileSync(path.join(app.getPath('userData'), 'provider-keys.dpapi'));
  check(!raw.toString('latin1').includes('gsk_test_secret_value'), 'API keys are not stored in plain text');
  check(secrets.status().groq.hint === '…1234', 'renderer-facing status only exposes the last 4 characters');
  await secrets.set('groq', '');

  const live = [
    ['gemini', process.env.GEMINI_API_KEY, /flash-lite-latest$/],
    ['groq', process.env.GROQ_API_KEY, /llama-3\.1-8b|llama-3\.3-70b/],
  ];
  for (const [p, key, prefer] of live) {
    if (!key) {
      console.log(`SKIP ${p}: no key in environment`);
      continue;
    }
    await secrets.set(p, key);
    const models = await providers.fetchModels(p);
    check(models.length > 0, `${p}: listed ${models.length} chat models`);
    const pick = models.find((m) => prefer.test(m.id)) || models[0];
    settings.update({ providers: { [p]: { models: [pick] } } });
    const listed = (await api.listModels()).models.map((m) => m.id);
    check(listed.includes(`${p}:${pick.id}`), `${p}: chosen model appears in the model menu`);
    let text = '';
    let doneEvent = null;
    const r = await api.ask({ reqId: 'x', body: { model: `${p}:${pick.id}`, messages: [{ role: 'user', text: 'Reply with exactly the word: pong', images: [] }] } }, (ev, data) => {
      if (ev === 'delta') text += data.text;
      if (ev === 'done') doneEvent = data;
      if (ev === 'error') console.log(`  error: ${data.message}`);
    });
    console.log(`  ${p} answer: ${JSON.stringify(text.trim().slice(0, 60))} · first token ${r.timings.firstTokenMs} ms`);
    check(r.outcome === 'ok' && /pong/i.test(text) && doneEvent, `${p}: streamed a real answer directly`);
    await secrets.set(p, '');
  }

  // OpenAI-compatible path (Groq / local servers) against an in-process fake server.
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'qwen2.5-vl-7b' }, { id: 'llama3.1:8b' }, { id: 'nomic-embed-text' }] }));
      } else if (req.url === '/v1/chat/completions') {
        res.setHeader('content-type', 'text/event-stream');
        for (const t of ['po', 'ng']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const localModels = await providers.fetchModels('local', { baseUrl: base });
  check(localModels.map((m) => m.id).join() === 'llama3.1:8b,qwen2.5-vl-7b', `local: embedding models filtered out (${localModels.map((m) => m.id).join(', ')})`);
  check(localModels.find((m) => m.id === 'qwen2.5-vl-7b').vision && !localModels.find((m) => m.id === 'llama3.1:8b').vision, 'local: image support guessed from model names');
  settings.update({ providers: { local: { baseUrl: base, label: 'Ollama', models: [{ id: 'qwen2.5-vl-7b', vision: true }] } } });
  await secrets.set('local', 'sk-local-123');
  const localMenu = (await api.listModels()).models.find((m) => m.id === 'local:qwen2.5-vl-7b');
  check(localMenu && localMenu.local && localMenu.group === 'Ollama (this network)', 'local: model listed under its display name');
  let localText = '';
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const lr = await api.ask({ reqId: 'l', body: { model: 'local:qwen2.5-vl-7b', messages: [{ role: 'user', text: 'what is this', images: [{ mime: 'image/png', data: png }] }] } }, (ev, data) => {
    if (ev === 'delta') localText += data.text;
  });
  const chat = seen.find((s) => s.url === '/v1/chat/completions');
  check(lr.outcome === 'ok' && localText === 'pong', 'local: streamed answer assembled from SSE chunks');
  check(chat.auth === 'Bearer sk-local-123', 'local: optional API key sent as a Bearer token');
  check(chat.body.model === 'qwen2.5-vl-7b' && chat.body.messages[1].content[0].type === 'image_url', 'local: image sent in OpenAI image_url format');
  server.close();
  await secrets.set('local', '');
  settings.update({ providers: { local: { baseUrl: '', models: [] } } });

  // Bad key gives a clear error
  if (process.env.GEMINI_API_KEY) {
    let msg = '';
    try {
      await providers.fetchModels('gemini', { apiKey: 'AIzaInvalidKeyForTesting000000000000000' });
    } catch (err) {
      msg = err.message;
    }
    console.log(`  bad key → ${msg}`);
    check(/rejected the API key/.test(msg), 'invalid Gemini key produces a readable error');
  }

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  app.exit(failures.length ? 1 : 0);
});
