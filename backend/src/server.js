import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config, assertSafeConfig } from './config.js';
import { initFirebase } from './firebase.js';
import { requireAuth } from './auth.js';
import { reserveRequest, recordUsage, getUsage, quotaBackend } from './quota.js';
import { validateAskBody } from './validate.js';
import { listModels, resolveModel } from './providers/index.js';

const SYSTEM_PROMPT = [
  'You are IntelliPointer, an assistant that answers questions about content the user selected on their screen.',
  'Attached images are cropped screen regions, labelled in order as Region 1, Region 2, ... when there are several.',
  'Text marked "OCR text" was extracted locally and may contain recognition errors; trust the image when they disagree.',
  'Be concise and direct. Use Markdown. Put code in fenced blocks with a language tag.',
].join(' ');

// Structured logs. Never log prompts, OCR text, images or tokens.
function log(level, msg, fields = {}) {
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields }));
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(helmet());

  // Coarse per-IP limit in front of auth, to blunt token-guessing floods.
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, providers: listModels().length > 0, quota: quotaBackend() });
  });

  const perUserLimit = rateLimit({
    windowMs: 60_000,
    limit: config.limits.requestsPerMinutePerUser,
    keyGenerator: (req) => req.user.uid,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited', message: 'Too many requests, slow down.' },
  });

  app.get('/v1/models', requireAuth, (_req, res) => {
    res.json({
      models: listModels().map(({ id, providerLabel, upstreamId, vision, webSearch }) => ({
        id, label: `${providerLabel} · ${upstreamId}`, vision, webSearch,
      })),
    });
  });

  app.get('/v1/usage', requireAuth, async (req, res) => {
    try {
      res.json(await getUsage(req.user.uid));
    } catch (err) {
      log('error', 'usage_failed', { error: err.message });
      res.status(500).json({ error: 'internal', message: 'Could not read usage.' });
    }
  });

  app.post(
    '/v1/ask',
    requireAuth,
    perUserLimit,
    express.json({ limit: config.limits.maxBodyBytes }),
    async (req, res) => {
      const requestId = randomUUID();
      const t0 = performance.now();

      const parsed = validateAskBody(req.body);
      if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error, message: parsed.message });
      const { model: modelId, messages, webSearch, imageCount } = parsed.value;

      const resolved = resolveModel(modelId);
      if (!resolved) return res.status(400).json({ error: 'unknown_model', message: `Model ${modelId} is not available.` });
      const { model, provider } = resolved;
      if (imageCount > 0 && !model.vision) {
        return res.status(400).json({ error: 'model_no_vision', message: `${model.id} cannot read images. Pick a vision model or send text only.` });
      }

      let quota;
      try {
        quota = await reserveRequest(req.user.uid);
      } catch (err) {
        log('error', 'quota_failed', { requestId, error: err.message });
        return res.status(503).json({ error: 'quota_unavailable', message: 'Quota service unavailable, retry shortly.' });
      }
      if (!quota.allowed) {
        return res.status(429).json({ error: 'quota_exceeded', message: `Daily limit of ${quota.limit} requests reached.` });
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const controller = new AbortController();
      let finished = false;
      res.on('close', () => {
        if (!finished) controller.abort(new Error('client_disconnected'));
      });
      const timeout = setTimeout(() => controller.abort(new Error('upstream_timeout')), config.limits.upstreamTimeoutMs);

      const useSearch = webSearch && model.webSearch;
      send('meta', { requestId, model: model.id, webSearch: useSearch, quota: { used: quota.used, limit: quota.limit } });

      const tUpstream = performance.now();
      let firstTokenMs = null;
      let usage = { inputTokens: 0, outputTokens: 0 };
      let outcome = 'ok';
      try {
        for await (const ev of provider.stream({
          model: model.upstreamId, messages, systemPrompt: SYSTEM_PROMPT, webSearch: useSearch, signal: controller.signal,
        })) {
          if (ev.type === 'delta') {
            if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - tUpstream);
            send('delta', { text: ev.text });
          } else if (ev.type === 'sources') {
            send('sources', { items: ev.items });
          } else if (ev.type === 'usage') {
            usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
          }
        }
        send('done', {
          usage,
          timings: { serverPreMs: Math.round(tUpstream - t0), firstTokenMs, totalMs: Math.round(performance.now() - t0) },
        });
      } catch (err) {
        const reason = controller.signal.aborted ? controller.signal.reason?.message : null;
        outcome = reason || 'upstream_error';
        if (reason !== 'client_disconnected') {
          send('error', {
            message: reason === 'upstream_timeout' ? 'The AI provider took too long to respond.' : err.message || 'Upstream error.',
            retryable: err.retryable ?? true,
          });
        }
      } finally {
        finished = true;
        clearTimeout(timeout);
        res.end();
        recordUsage(req.user.uid, { ...usage, provider: provider.id, model: model.id });
        log('info', 'ask', {
          requestId, uid: req.user.uid, model: model.id, images: imageCount, turns: messages.length,
          webSearch: useSearch, outcome, firstTokenMs, totalMs: Math.round(performance.now() - t0), ...usage,
        });
      }
    },
  );

  // JSON body errors (too large / malformed) without stack traces.
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Request body too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON.' });
    log('error', 'unhandled', { error: err.message });
    return res.status(500).json({ error: 'internal', message: 'Internal error.' });
  });

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const problems = assertSafeConfig();
  if (problems.length) {
    for (const p of problems) log('fatal', 'config', { problem: p });
    process.exit(1);
  }
  initFirebase();
  if (config.authDisabled) log('warn', 'AUTH_DISABLED: every request is treated as user local-dev. Development only.');
  if (quotaBackend() === 'memory') log('warn', 'No FIREBASE_SERVICE_ACCOUNT_JSON: quotas are in-memory and reset on restart.');
  createApp().listen(config.port, config.host, () => {
    log('info', 'listening', { host: config.host, port: config.port, models: listModels().map((m) => m.id) });
  });
}
