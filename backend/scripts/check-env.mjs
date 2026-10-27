// Checks backend/.env without ever printing a secret value.
//   npm run check:env
// Reports which variables are set, whether the Gemini key has the right shape
// and is accepted by Google, and whether the Firebase service account matches
// FIREBASE_PROJECT_ID.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = process.env.IP_ENV_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (!fs.existsSync(envFile)) {
  console.error('backend/.env not found. Copy .env.example to .env first.');
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

let failed = 0;
const ok = (name, detail = '') => console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail = '') => {
  failed += 1;
  console.log(`  FIX   ${name}${detail ? ` — ${detail}` : ''}`);
};
const warn = (name, detail = '') => console.log(`  note  ${name}${detail ? ` — ${detail}` : ''}`);

console.log(`Checking ${envFile}\n`);

// Project id
if (env.FIREBASE_PROJECT_ID) ok('FIREBASE_PROJECT_ID', env.FIREBASE_PROJECT_ID);
else bad('FIREBASE_PROJECT_ID', 'not set');

// Gemini key: shape first, then ask Google (a list-models call; nothing is printed)
const key = env.GEMINI_API_KEY || '';
if (!key) {
  bad('GEMINI_API_KEY', 'empty. Create a new key at https://aistudio.google.com/apikey and paste it into backend/.env');
} else if (!/^AIza[0-9A-Za-z_-]{35}$/.test(key)) {
  bad('GEMINI_API_KEY', `does not look like a Gemini key (length ${key.length})`);
} else {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000),
    });
    if (res.ok) ok('GEMINI_API_KEY', `accepted by Google (ends …${key.slice(-4)})`);
    else bad('GEMINI_API_KEY', `Google rejected it (HTTP ${res.status}). It may be revoked, so create a new one.`);
  } catch (err) {
    warn('GEMINI_API_KEY', `format is right, but Google could not be reached (${err.message})`);
  }
}

// Service account
const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
if (!raw) {
  warn('FIREBASE_SERVICE_ACCOUNT_JSON', 'empty: quotas will be in memory only. Run `npm run env:service-account -- <downloaded-key.json>`');
} else {
  try {
    const sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (sa.type !== 'service_account' || !sa.private_key || !sa.client_email) bad('FIREBASE_SERVICE_ACCOUNT_JSON', 'not a service-account key');
    else if (sa.project_id !== env.FIREBASE_PROJECT_ID) bad('FIREBASE_SERVICE_ACCOUNT_JSON', `belongs to project "${sa.project_id}", not "${env.FIREBASE_PROJECT_ID}"`);
    else ok('FIREBASE_SERVICE_ACCOUNT_JSON', `valid for ${sa.project_id} (${sa.client_email})`);
  } catch {
    bad('FIREBASE_SERVICE_ACCOUNT_JSON', 'could not be read as JSON or base64 JSON');
  }
}

// Production safety
if (env.NODE_ENV === 'production' && env.AUTH_DISABLED === 'true') bad('AUTH_DISABLED', 'must not be true in production');
else ok('AUTH_DISABLED', 'not enabled');
if (env.NODE_ENV === 'production' && env.TRUST_PROXY !== '1') warn('TRUST_PROXY', 'set it to 1 behind Render or Cloud Run so per-IP limits see real client addresses');

console.log(failed ? `\n${failed} item(s) to fix.` : '\nAll set. Copy the same values into Render (Environment) when you deploy.');
process.exit(failed ? 1 : 0);
