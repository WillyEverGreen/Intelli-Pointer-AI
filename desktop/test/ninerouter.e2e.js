// Live check against a running 9Router (default http://127.0.0.1:20127/v1):
// capability-based vision flags, a speed test, and an image question.
// Run: npx electron test/ninerouter.e2e.js [baseUrl]
const path = require('node:path');
const { app } = require('electron');

const base = process.argv[2] || 'http://127.0.0.1:20127/v1';
app.setPath('userData', path.join(require('node:os').tmpdir(), `intellipointer-9router-test-${process.pid}`));

app.whenReady().then(async () => {
  const check = (c, m) => console.log(`${c ? 'PASS' : 'FAIL'} ${m}`);
  const secrets = require('../src/main/secrets');
  await secrets.load();
  const providers = require('../src/main/providers');
  const models = await providers.fetchModels('local', { baseUrl: base });
  const vision = models.filter((m) => m.vision);
  check(models.length && models.every((m) => m.visionSource === 'server'), `${models.length} models, image support reported by 9Router for all`);
  check(vision.length > 0, `${vision.length} vision models`);
  const candidates = vision.filter((m) => !m.reasoning).slice(0, 4);
  const timed = [];
  for (const m of candidates) {
    const r = await providers.speedTest('local', m.id, { baseUrl: base });
    console.log(`  ${m.id}: ${r.ok ? `${r.firstTokenMs} ms` : `failed (${r.error})`}`);
    if (r.ok) timed.push([m.id, r.firstTokenMs]);
  }
  check(timed.length > 0, 'at least one vision model answered the speed test');
  if (timed.length) {
    timed.sort((a, b) => a[1] - b[1]);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    let text = '';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60000);
    try {
      for await (const ev of providers.stream({ modelId: `local:${timed[0][0]}`, messages: [{ role: 'user', text: 'This is a tiny test image. Reply with one word: received.', images: [{ mime: 'image/png', data: png }] }], signal: ac.signal, override: { baseUrl: base } })) {
        if (ev.type === 'delta') text += ev.text;
      }
    } catch (err) {
      text = `ERROR ${err.message}`;
    }
    console.log(`  image reply from ${timed[0][0]}: ${JSON.stringify(text.slice(0, 80))}`);
    check(text && !text.startsWith('ERROR'), 'fastest vision model accepted an image');
  }
  app.exit(0);
});
