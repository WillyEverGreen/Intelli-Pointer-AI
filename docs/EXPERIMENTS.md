# Register of experiments

Every experiment, test and measurement carried out on IntelliPointer AI, by name. "Pass" means the automated check passed in the final run (`npm run test:all` in `backend/`, `npm test` and the `test/*.e2e.js` suites in `desktop/`). Measured values are from a 1920×1080 display at 125 % scaling.

## A. Backend unit tests (13)

Command: `cd backend && npm test`

| ID | Experiment | What it shows | Result |
|---|---|---|---|
| B1 | Accepts a text question | A valid request is parsed | Pass |
| B2 | Accepts a real PNG | A genuine image passes validation | Pass |
| B3 | Rejects a declared PNG whose bytes are not PNG | File type is checked by signature, not by name | Pass |
| B4 | Rejects an unsupported MIME type | Only PNG, JPEG and WebP are allowed | Pass |
| B5 | Rejects images in assistant turns and bad roles | Message structure is enforced | Pass |
| B6 | Last message must be from the user | Malformed conversations are refused | Pass |
| B7 | Rejects oversized text | Length limit enforced | Pass |
| B8 | Recognises JPEG and WebP signatures | Image sniffing works for all allowed types | Pass |
| B9 | Health endpoint is public | Platform health checks work without login | Pass |
| B10 | Ask without a token is 401 | Authentication is required | Pass |
| B11 | Ask with a forged token is 401 | Fake tokens are refused | Pass |
| B12 | Models endpoint requires authentication | No anonymous access | Pass |
| B13 | Security headers are set and `x-powered-by` is hidden | Basic hardening in place | Pass |

## B. Backend integration tests on the real Firebase emulators (13)

Command: `cd backend && npm run test:emulator` (real Firebase Authentication and Cloud Firestore emulators; a local fake model server).

| ID | Experiment | What it shows | Result |
|---|---|---|---|
| E1 | Health reports Firestore-backed quotas | The service is wired to Firestore | Pass |
| E2 | Requests without a valid Firebase ID token are rejected | Authentication enforced with real tokens | Pass |
| E3 | A real emulator ID token is accepted and models are listed with capabilities | Token verification and the model list | Pass |
| E4 | `/v1/ask` streams SSE (meta, delta, done) and records usage in Firestore | Streaming works; only counters are stored | Pass |
| E5 | Daily quota holds under a burst of concurrent requests | 12 parallel requests, limit 5: exactly 5 allowed, counter never overshoots (atomic transactions) | Pass |
| E6 | One user's quota does not affect another user's | Per-user isolation | Pass |
| E7 | Revoked sessions and disabled accounts are rejected | Immediate access removal | Pass |
| E8 | Input validation: image size, image on a text-only model, unknown model | Correct refusals (413, 400) | Pass |
| E9 | Upstream failures surface as a retryable SSE error | Graceful failure handling | Pass |
| E10 | A client that disconnects cancels the upstream request | No wasted model calls | Pass |
| E11 | Logs never contain prompts or tokens | Privacy of logs | Pass |
| E12 | Per-user rate limit returns 429 independent of the daily quota | Abuse protection | Pass |
| E13 | Firestore security rules deny every client read and write | A user cannot read or reset their own quota | Pass |

## C. Deployment verification checks (12)

Command: `cd backend && npm run verify:deployment -- --url <service URL> ...` (run locally against the real Gemini API: 12 of 12; to be run again on the deployed service).

| ID | Check | Result |
|---|---|---|
| V1 | HTTPS is used | Pass (local) |
| V2 | `GET /healthz` responds | Pass |
| V3 | Warm response time | Pass |
| V4 | Quotas are stored in Firestore | Pass locally (in-memory expected); must show `firestore` when deployed |
| V5 | Security headers present | Pass |
| V6 | `GET /v1/models` lists models with capability flags | Pass |
| V7 | `POST /v1/ask` streams an answer | Pass (first token 0.7–3.6 s in two runs) |
| V8 | Answer is delivered as Server-Sent Events | Pass |
| V9 | Usage counter incremented | Pass |
| V10 | An image question is accepted by a vision model | Pass |
| V11 | A file that is not really a PNG is rejected (415) | Pass |
| V12 | An oversized request is rejected (413) | Pass |

## D. Desktop unit tests (3)

Command: `cd desktop && npm test`

| ID | Experiment | What it shows | Result |
|---|---|---|---|
| D1 | SSE parser handles events split across chunks | Streaming parser is robust | Pass |
| D2 | SSE parser defaults the event name and ignores comments | Protocol edge cases | Pass |
| D3 | Compiled native helper starts, grabs the screen and stays small | Ready in about 100 ms; 1080p grab about 110 ms; 16 MB | Pass |

## E. Desktop end-to-end suites (Electron)

### E.1 Selection overlay (`test/overlay.e2e.js`, 10 checks)

| ID | Experiment | Result |
|---|---|---|
| O1 | Overlay is active before the screenshot arrives | Pass |
| O2 | User can start selecting immediately | Pass |
| O3 | Screenshot swapped in as the frozen background | Pass |
| O4 | Enter confirms the selection | Pass |
| O5 | Two regions captured | Pass |
| O6 | Region shapes are rectangle and ellipse | Pass |
| O7 | A region can be moved (200, 210) | Pass |
| O8 | Region cropped at physical resolution (449×299 at 1.5× scaling) | Pass |
| O9 | Crop is a PNG | Pass |
| O10 | No renderer console errors | Pass |

### E.2 Panel, model menu, settings and commands (`test/ui.e2e.js`, 16 checks)

| ID | Experiment | Result |
|---|---|---|
| U1 | Ask bar sizes itself to its commands | Pass |
| U2 | Custom command in the Ask bar sends its id | Pass |
| U3 | Empty state shows the new shortcuts | Pass |
| U4 | One button per command | Pass |
| U5 | Model button shows the current model | Pass |
| U6 | Models are grouped by source | Pass |
| U7 | Search filters the model list | Pass |
| U8 | Enter chooses the highlighted model | Pass |
| U9 | Menu closes after choosing | Pass |
| U10 | Source list shows Gemini, Groq, 9Router and IntelliPointer Cloud | Pass |
| U11 | Each source has a show-in-menu switch | Pass |
| U12 | Command editor opens as a sheet | Pass |
| U13 | New command added to the list | Pass |
| U14 | Saved command persisted to settings | Pass |
| U15 | Shortcut recorder shows Alt+Shift+S | Pass |
| U16 | No renderer console errors | Pass |

### E.3 Selected text and clipboard (`test/selection.e2e.js`, 10 checks)

| ID | Experiment | Result |
|---|---|---|
| S1 | Helper became ready | Pass |
| S2 | Selected text read via UI Automation | Pass |
| S3 | Automation read is fast when the helper answers | Pass |
| S4 | Concurrent requests both resolve | Pass |
| S5 | Ctrl+C fallback is skipped for consoles | Pass |
| S6 | The user's text clipboard is restored after the copy attempt | Pass |
| S7 | Clipboard image restored and read back as PNG | Pass |
| S8 | Text and HTML restored together | Pass |
| S9 | Recent mouse selection remembered for fallback | Pass |
| S10 | Stale mouse selections are ignored | Pass |

### E.4 Screen-region shortcut speed (`test/capture.e2e.js`, 3 rounds, one of them after 15 s idle)

| ID | Experiment (per round) | Result |
|---|---|---|
| C1 | Overlay painted on screen in under 100 ms | 5–39 ms |
| C2 | Confirm before the screenshot arrives still returns a full-resolution crop | Pass |
| C3 | Fast BitBlt path used | Pass |
| C4 | Screenshot ready in under 600 ms | 109–338 ms |
| C5 | Shortcut to finished crop in under 1 s | 228–519 ms |
| C6 | Overlay hidden after confirm | Pass |
| C7 | Overlay reset (no stale frame next time) | Pass |

### E.5 Overlay excluded from screenshots (`test/capture-exclusion.e2e.js`, 2 checks)

| ID | Experiment | Result |
|---|---|---|
| X1 | A content-protected window is excluded from the capture | Pass |
| X2 | A normal window is captured (control) | Pass |

### E.6 Model providers and key storage (`test/providers.e2e.js`)

| ID | Experiment | Result |
|---|---|---|
| P1 | Plain-HTTP local server outside the local network is rejected | Pass |
| P2 | LAN HTTP URL accepted and normalised | Pass |
| P3 | API keys are not stored in plain text | Pass |
| P4 | The interface only sees the last four characters of a key | Pass |
| P5 | Gemini: listed chat models | Pass (20 models) |
| P6 | Gemini: chosen model appears in the model menu | Pass |
| P7 | Gemini: streamed a real answer directly | Pass |
| P8 | Local server: embedding models filtered out | Pass |
| P9 | Local server: image support guessed from model names | Pass |
| P10 | Local server: model listed under its display name | Pass |
| P11 | Local server: streamed answer assembled from SSE chunks | Pass |
| P12 | Local server: optional API key sent as a Bearer token | Pass |
| P13 | Local server: image sent in the OpenAI image format | Pass |
| P14 | An invalid Gemini key produces a readable error | Pass |
| P15 | Groq: listing, streaming (needs a Groq key) | Not run (no key available) |

### E.7 Live conversation through the cloud API (`test/panel.e2e.js`)

| ID | Experiment | Result |
|---|---|---|
| L1 | Panel loaded models from the backend | Pass |
| L2 | Local OCR read the code text from the screenshot | Pass (0.7–1.3 s) |
| L3 | Privacy notice lists what will be sent | Pass |
| L4 | Answer streamed without error | Pass (first token 3.2–22 s depending on provider load) |
| L5 | Answer contains the fixed code | Pass |
| L6 | Follow-up answered from the same screenshot context | Pass |
| L7 | No renderer console errors | Pass |

## F. Performance and design experiments (measured)

| ID | Experiment | Compared | Result |
|---|---|---|---|
| F1 | Screenshot method | Electron's grabber vs GDI BitBlt | 2.4–2.8 s after idle vs 109–338 ms |
| F2 | Overlay ordering | Capture first, then show vs show first, capture behind | 250 ms to over 2.5 s vs 5–39 ms to appear |
| F3 | Native helper host | PowerShell host vs compiled C# program | About 127 MB and 1.6–4.6 s to start vs 16 MB and 100–400 ms |
| F4 | GPU acceleration | On vs off (software rendering) | GPU process 128 MB vs 25 MB; total private memory 270 MB vs 164 MB; crop time unchanged |
| F5 | App memory overall | Before vs after the optimisations | About 397 MB to about 183 MB |
| F6 | Idle CPU | After optimisation | 0.1–0.3 % |
| F7 | OCR engine lifecycle | Always loaded vs on demand and unloaded when idle | No cost until a capture starts |
| F8 | Model latency | Gemini through the backend, repeated runs | 0.7 s to about 20 s to first token; provider overload produced HTTP 503 and a 90 s timeout, shown as a retryable error |
| F9 | Model speed test | 9Router models listed with vision flags (70 of 105 read images) | Fastest chosen per measured first-token time |
| F10 | Clean-clone deployment test | Fresh checkout, `npm ci --omit=dev`, production start | Health OK, unauthenticated request 401 |

## G. Security experiments and reviews

| ID | Experiment | Result |
|---|---|---|
| G1 | Dependency audit, backend (before) | 8 moderate findings, all from one transitive package |
| G2 | Dependency audit after upgrading firebase-admin | 0 vulnerabilities (backend and desktop) |
| G3 | Revocation timing experiment | Revocation has one-second resolution; test waits out the second |
| G4 | Firestore rules experiment | Anonymous and signed-in clients both refused (403); admin access allowed |
| G5 | Secret scan before every commit | No key or token in the repository or its history |
| G6 | STRIDE threat model | Documented in `docs/SECURITY.md` |
| G7 | Key-leak response drill | Procedure documented in `docs/DEPLOYMENT.md` |
