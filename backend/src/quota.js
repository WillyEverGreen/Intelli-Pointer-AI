import { FieldValue } from 'firebase-admin/firestore';
import { config } from './config.js';
import { db } from './firebase.js';

// Per-user daily quota. Stored in Firestore (collection "usage", one doc per
// user per UTC day) when a service account is configured; otherwise an
// in-memory counter is used and the server logs that quotas are not durable.
// Only counters and token totals are stored — never prompts or screenshots.

const memory = new Map();

function dayKey(uid) {
  return `${uid}_${new Date().toISOString().slice(0, 10)}`;
}

export function quotaBackend() {
  return db() ? 'firestore' : 'memory';
}

// Atomically reserves one request. Returns { allowed, used, limit }.
export async function reserveRequest(uid) {
  const limit = config.limits.dailyRequestsPerUser;
  const key = dayKey(uid);
  const firestore = db();

  if (!firestore) {
    const used = memory.get(key) || 0;
    if (used >= limit) return { allowed: false, used, limit };
    memory.set(key, used + 1);
    return { allowed: true, used: used + 1, limit };
  }

  const ref = firestore.collection('usage').doc(key);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists ? snap.get('requests') || 0 : 0;
    if (used >= limit) return { allowed: false, used, limit };
    tx.set(
      ref,
      { uid, day: key.slice(-10), requests: used + 1, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { allowed: true, used: used + 1, limit };
  });
}

export async function recordUsage(uid, { inputTokens = 0, outputTokens = 0, provider, model }) {
  const firestore = db();
  if (!firestore) return;
  try {
    await firestore.collection('usage').doc(dayKey(uid)).set(
      {
        inputTokens: FieldValue.increment(inputTokens),
        outputTokens: FieldValue.increment(outputTokens),
        lastProvider: provider,
        lastModel: model,
      },
      { merge: true },
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'warn', msg: 'usage_record_failed', error: err.message }));
  }
}

export async function getUsage(uid) {
  const limit = config.limits.dailyRequestsPerUser;
  const key = dayKey(uid);
  const firestore = db();
  if (!firestore) return { used: memory.get(key) || 0, limit, backend: 'memory' };
  const snap = await firestore.collection('usage').doc(key).get();
  return {
    used: snap.exists ? snap.get('requests') || 0 : 0,
    inputTokens: snap.exists ? snap.get('inputTokens') || 0 : 0,
    outputTokens: snap.exists ? snap.get('outputTokens') || 0 : 0,
    limit,
    backend: 'firestore',
  };
}
