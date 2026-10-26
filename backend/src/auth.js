import { config } from './config.js';
import { firebaseAuth } from './firebase.js';

// Express middleware: requires a valid Firebase ID token in
// "Authorization: Bearer <token>" and attaches { uid, email } to req.user.
export async function requireAuth(req, res, next) {
  if (config.authDisabled) {
    req.user = { uid: 'local-dev', email: null, insecureLocal: true };
    return next();
  }

  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return res.status(401).json({ error: 'missing_token', message: 'Sign in required.' });
  }

  const auth = firebaseAuth();
  if (!auth) {
    return res.status(503).json({ error: 'auth_unavailable', message: 'Authentication is not configured.' });
  }

  try {
    // checkRevoked=true so disabled/revoked accounts are rejected immediately.
    const decoded = await auth.verifyIdToken(match[1], true);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    return next();
  } catch (err) {
    const expired = err?.code === 'auth/id-token-expired';
    return res.status(401).json({
      error: expired ? 'token_expired' : 'invalid_token',
      message: expired ? 'Session expired, refresh and retry.' : 'Invalid credentials.',
    });
  }
}
