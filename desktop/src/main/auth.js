const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const settings = require('./settings');

// Firebase Authentication via its official REST API (email + password).
// - The password is sent straight to Google over HTTPS and never stored.
// - The long-lived refresh token is encrypted with Electron safeStorage,
//   which uses Windows DPAPI (bound to the current Windows user).
// - The short-lived ID token stays in main-process memory only; the renderer
//   never sees any token.

const sessionFile = () => path.join(app.getPath('userData'), 'session.bin');
let session = null; // { idToken, refreshToken, expiresAt, email, uid }
let secureStorage = false;

function apiKey() {
  const key = settings.get().firebaseApiKey;
  if (!key) throw new Error('Set the Firebase Web API key in Settings first.');
  return key;
}

async function persist() {
  if (!session) {
    fs.rmSync(sessionFile(), { force: true });
    return;
  }
  if (!secureStorage) return; // no OS encryption: keep the session in memory only
  const payload = JSON.stringify({ refreshToken: session.refreshToken, email: session.email, uid: session.uid });
  fs.writeFileSync(sessionFile(), await safeStorage.encryptStringAsync(payload));
}

async function restore() {
  try {
    secureStorage = await safeStorage.isAsyncEncryptionAvailable();
    if (!secureStorage || !fs.existsSync(sessionFile())) return;
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(sessionFile()));
    session = { ...JSON.parse(result), idToken: null, expiresAt: 0 };
    if (shouldReEncrypt) await persist();
  } catch {
    session = null;
  }
}

async function firebaseCall(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body?.error?.message || `HTTP ${res.status}`;
    const friendly = {
      INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
      EMAIL_NOT_FOUND: 'Wrong email or password.',
      INVALID_PASSWORD: 'Wrong email or password.',
      EMAIL_EXISTS: 'An account with this email already exists.',
      USER_DISABLED: 'This account has been disabled.',
      TOKEN_EXPIRED: 'Session expired, sign in again.',
    }[code.split(' ')[0]];
    throw new Error(friendly || `Sign-in failed: ${code}`);
  }
  return body;
}

async function signIn(email, password, { create = false } = {}) {
  const endpoint = create ? 'accounts:signUp' : 'accounts:signInWithPassword';
  const body = await firebaseCall(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(apiKey())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  session = {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + Number(body.expiresIn) * 1000,
    email: body.email,
    uid: body.localId,
  };
  await persist();
  return status();
}

async function refresh() {
  if (!session?.refreshToken) throw new Error('Not signed in.');
  const body = await firebaseCall(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken }),
  });
  session = {
    ...session,
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in) * 1000,
  };
  await persist();
}

// Returns a valid ID token, refreshing one minute before expiry.
async function getIdToken({ forceRefresh = false } = {}) {
  if (!session) throw new Error('Not signed in.');
  if (forceRefresh || !session.idToken || Date.now() > session.expiresAt - 60_000) await refresh();
  return session.idToken;
}

async function signOut() {
  session = null;
  await persist();
  return status();
}

function status() {
  return { signedIn: Boolean(session), email: session?.email || null, secureStorage };
}

module.exports = { restore, signIn, signOut, getIdToken, status };
