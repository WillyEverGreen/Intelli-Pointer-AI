import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config.js';

let app = null;
let firestore = null;

function parseServiceAccount(raw) {
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text);
}

export function initFirebase() {
  if (app || !config.firebase.projectId) return;
  const serviceAccount = parseServiceAccount(config.firebase.serviceAccountJson);
  app = initializeApp({
    projectId: config.firebase.projectId,
    ...(serviceAccount ? { credential: cert(serviceAccount) } : {}),
  });
  // ID-token verification only needs the project ID (public signing keys).
  // Firestore needs a service account credential.
  if (serviceAccount) firestore = getFirestore(app);
}

export function firebaseAuth() {
  return app ? getAuth(app) : null;
}

export function db() {
  return firestore;
}
