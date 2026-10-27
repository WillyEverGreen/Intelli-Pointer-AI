// Central, validated configuration. Every value comes from the environment;
// nothing secret is ever hardcoded here.

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function list(v, def = []) {
  if (!v) return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

export const config = {
  port: int(env.PORT, 8080),
  host: env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1'),
  isProduction,
  // Number of reverse-proxy hops to trust for client IP (Render/Cloud Run = 1).
  trustProxy: int(env.TRUST_PROXY, 0),

  firebase: {
    projectId: env.FIREBASE_PROJECT_ID || '',
    // Service account JSON, either raw JSON or base64. Enables Firestore quotas.
    serviceAccountJson: env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    // Use the platform's own credentials (Google Cloud Run / GCE metadata,
    // `gcloud auth application-default login`) instead of a key file. This is
    // the most secure option: there is no long-lived secret to leak.
    // Cloud Run sets K_SERVICE automatically.
    useAdc: bool(env.FIRESTORE_USE_ADC, Boolean(env.K_SERVICE)),
  },

  // Local development escape hatch. Refused in production and on non-loopback hosts.
  authDisabled: bool(env.AUTH_DISABLED),

  limits: {
    dailyRequestsPerUser: int(env.DAILY_REQUEST_LIMIT, 100),
    requestsPerMinutePerUser: int(env.RATE_LIMIT_PER_MINUTE, 20),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 12 * 1024 * 1024),
    maxImageBytes: int(env.MAX_IMAGE_BYTES, 4 * 1024 * 1024),
    maxImagesPerRequest: int(env.MAX_IMAGES, 4),
    maxMessages: int(env.MAX_MESSAGES, 24),
    maxTextChars: int(env.MAX_TEXT_CHARS, 20000),
    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 90000),
  },

  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    models: list(env.GEMINI_MODELS, ['gemini-flash-latest', 'gemini-flash-lite-latest']),
  },

  // Any OpenAI-compatible endpoint (e.g. a 9Router instance, OpenRouter, Groq).
  openaiCompat: {
    baseUrl: (env.OPENAI_COMPAT_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: env.OPENAI_COMPAT_API_KEY || '',
    label: env.OPENAI_COMPAT_LABEL || 'OpenAI-compatible',
    // "model-id:vision,other-model" — ":vision" marks image support.
    models: list(env.OPENAI_COMPAT_MODELS),
  },
};

export function assertSafeConfig() {
  const problems = [];
  if (config.authDisabled) {
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
    if (config.isProduction || !loopback) {
      problems.push('AUTH_DISABLED=true is only allowed in development on a loopback HOST.');
    }
  } else if (!config.firebase.projectId) {
    problems.push('FIREBASE_PROJECT_ID is required (or set AUTH_DISABLED=true for local development).');
  }
  if (!config.gemini.apiKey && !config.openaiCompat.baseUrl) {
    problems.push('Configure at least one AI provider: GEMINI_API_KEY or OPENAI_COMPAT_BASE_URL.');
  }
  return problems;
}
