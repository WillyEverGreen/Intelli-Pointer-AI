# Security design and threat model

Every control below names where it is implemented and the automated test that
proves it. "Emulator" tests are `backend/test/emulator.test.js`, which runs
the real backend against the real Firebase Authentication and Firestore
emulators (`npm run test:emulator`).

## Assets

| Asset | Why it matters |
|---|---|
| Provider API keys (Gemini, others) | Cost and abuse if leaked |
| User sign-in tokens | Account takeover |
| Screenshots, selected text, prompts | Can contain private or sensitive information |
| Quota counters | Fair use and cost control |

## Controls by layer

### Identity: authentication and authorization (cloud)

| Control | Implementation | Evidence |
|---|---|---|
| Every `/v1/*` request needs a Firebase ID token, verified with revocation checking | `backend/src/auth.js` (`verifyIdToken(token, true)`) | Emulator: *requests without a valid token are rejected*; *a real emulator token is accepted*. Unit: *ask with forged token is 401* |
| Revoked sessions and disabled accounts are refused immediately | same | Emulator: *revoked sessions and disabled accounts are rejected* |
| Authorization by verified `uid`: a user can only consume their own quota; the client never supplies a user id | `backend/src/quota.js` (document id `{uid}_{day}`) | Emulator: *one user's quota does not affect another user's* |
| Firestore security rules deny **all** client access; only the backend's admin credentials can read or write | `firebase/firestore.rules` | Emulator: *Firestore security rules deny every client read and write*, including a signed-in user reading or resetting their own quota |
| Least privilege on Google Cloud Run: the service account gets only `roles/datastore.user` and access to the specific secrets; no key file exists | `docs/DEPLOYMENT.md` (Cloud Run section), `FIRESTORE_USE_ADC` | Configuration review |

### Secrets and configuration

| Control | Implementation | Evidence |
|---|---|---|
| No secret in the repository or in the desktop app: the Gemini key and service account live only in the host's secret environment | `.gitignore` (`.env`, `serviceAccount*.json`), `backend/.env.example`, `render.yaml` (`sync: false`) | Staged-diff secret scan before every commit; the desktop app contains only the public Firebase web key |
| On Cloud Run no long-lived key is needed at all (Application Default Credentials) | `backend/src/firebase.js`, `config.js` | Configuration review |
| Development bypass cannot reach production: `AUTH_DISABLED=true` is refused with `NODE_ENV=production` or any non-loopback host | `config.js` `assertSafeConfig()` | Startup refuses to run |
| User-entered provider keys are encrypted with Windows DPAPI and only the main process can read them; the UI sees the last four characters | `desktop/src/main/secrets.js` | Electron test *API keys are not stored in plain text* |

### Input validation and abuse protection (cloud)

| Control | Implementation | Evidence |
|---|---|---|
| Body size, message count and text length limits | `config.js` limits, `validate.js`, `express.json({limit})` | Unit: *rejects oversized text*; verifier: *oversized request is rejected (413)* |
| Images are validated by **file signature**, not declared type, and by size and count | `validate.js` `sniffImageMime` | Unit: *rejects declared PNG whose bytes are not PNG*; Emulator: *input validation*; verifier: *file that is not really a PNG is rejected (415)* |
| A model that cannot read images never receives an image | `server.js` capability check | Emulator: *image on a text-only model* |
| Per-IP limit before authentication, per-user limit after | `server.js` (`express-rate-limit`) | Emulator: *per-user rate limit returns 429* |
| Daily quota reserved in a Firestore **transaction**, so concurrent requests cannot exceed it | `quota.js` `reserveRequest` | Emulator: *the daily quota holds under a burst of concurrent requests*: exactly 5 of 12 parallel requests are allowed and the counter never overshoots |
| Upstream timeout (90 s); upstream request aborted when the client disconnects | `server.js` | Emulator: *a client that disconnects cancels the upstream request* |

### Transport and platform

| Control | Implementation | Evidence |
|---|---|---|
| HTTPS only: TLS terminated by the platform; the desktop app refuses a non-HTTPS backend except localhost | `settings.js` `checkUrl` | Electron test: *plain-HTTP server outside the local network is rejected* |
| Secure HTTP headers (`helmet`: HSTS, nosniff, frame protection), `x-powered-by` removed | `server.js` | Unit: *security headers are set*; verifier checks them on the live URL |
| Container runs as a non-root user | `backend/Dockerfile` (`USER node`) | Configuration review |
| Dependency vulnerabilities: `npm audit` reports 0 for production dependencies in both packages; CI fails on any moderate or higher finding | `.github/workflows/ci.yml` | CI + `npm audit --omit=dev` |

### Privacy

| Control | Implementation | Evidence |
|---|---|---|
| Screenshots, OCR text and prompts are **never stored**, in the cloud or on disk | Firestore documents hold counters only | Emulator: *usage is recorded in Firestore* asserts the exact set of stored fields |
| Logs never contain prompts, OCR text, images or tokens | `server.js` `log()` (ids, counts, timings only) | Emulator: *logs never contain prompts or tokens* |
| The user is told what will be sent before every request; a blur tool removes sensitive regions before capture; local-only mode blocks all uploads | `desktop/src/renderer/panel/panel.js`, overlay blur | Manual demonstration |

### Desktop application hardening

| Control | Implementation |
|---|---|
| Renderers are sandboxed with context isolation, no Node integration, a strict Content-Security-Policy, blocked navigation, and only `https:` links open externally | `desktop/src/main/main.js` window options, each `*.html` CSP |
| Tokens and keys never reach a renderer: network calls run in the main process; IPC handlers verify the sender | `api.js`, `providers.js`, `main.js` `handlePanel` |
| Firebase refresh token encrypted with DPAPI (`safeStorage`), the 1-hour ID token held in memory only | `desktop/src/main/auth.js` |
| Selected-text reading skips password fields; Ctrl+C is never sent to terminals; the clipboard is restored | `native/selection-helper.cs`, `clipboard.js` |

## Threat model (STRIDE)

| Threat | Example | Mitigation |
|---|---|---|
| **S**poofing | Calling the API with a forged or stolen token | Signature + revocation check on every request; short-lived tokens; HTTPS |
| **T**ampering | A user edits their own quota in Firestore | Rules deny all clients; only the backend writes; transactions |
| **R**epudiation | "I never made those requests" | Structured logs with request id, user id, model, outcome (no content) |
| **I**nformation disclosure | Keys or screenshots leaking | Keys only in server secrets or DPAPI; nothing stored; logs redacted; CSP and sandbox on the client |
| **D**enial of service / cost abuse | One user flooding the API or burning the free quota | Per-IP, per-user and daily limits; body and image limits; timeouts; stateless scaling on the platform |
| **E**levation of privilege | A client reaching the admin side of Firestore | Rules deny clients; the service account has only the roles it needs; no key file on Cloud Run |

## Known limitations (stated honestly)

- The **per-minute** rate limiter keeps its counters in each instance's memory,
  so with several instances the effective limit is multiplied. The **daily
  quota** is global (Firestore), so cost stays bounded. A shared limiter
  (for example Firestore or Redis) would be the next step if the service scales out.
- **Firebase App Check** (attesting that requests come from the genuine desktop app) is not enabled; the Firebase web key is public by design.
- **Email verification** is not enforced; anyone can create an account, and the daily quota is what limits abuse. Enable email-link or Google sign-in plus verification for a public launch.
- Password rules are Firebase's defaults.
- The Windows installer is not code-signed.
