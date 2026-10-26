# IntelliPointer AI: Screen-Aware AI Assistant with a Cloud Backend

**Cloud Computing Lab: Mini-Project** · Fr. Conceicao Rodrigues College of Engineering, Dept. of Computer Engineering

| | |
|---|---|
| Student name / Roll no. | _fill in_ |
| Teammates / Roll nos. | _fill in_ |
| Date of submission | _fill in_ |

> Draft generated from the implemented system. Sections marked _fill in_ need your own data (names, your measured numbers, screenshots).

---

## 1. Problem statement

Asking an AI about something on screen today takes many manual steps:
1. Take a screenshot.
2. Crop it.
3. Open a chatbot website.
4. Paste the image.
5. Type out the context.
6. Wait.
7. Switch back to the original application.

Each step breaks concentration. Cloud AI APIs need secret keys, so they cannot be called safely from a desktop app that is handed to users. They also need protection against abuse: authentication, quotas, rate limits and input validation.

**Goal:** a Windows desktop assistant that lets a user mark any part of the screen and get a streamed AI answer in a floating window in a few seconds. A secure cloud backend owns all secrets, authenticates every user, and enforces per-user limits.

## 2. Objectives

1. Global hotkey → full-screen selection overlay with rectangle, square, ellipse and freehand lasso selection, plus annotation tools (pen, arrow, highlight, blur).
2. Automatic capture and cropping of the marked regions at native resolution on multi-monitor, mixed-DPI setups.
3. Local OCR, so text content can be sent as text (smaller, faster) and the user can see what was read.
4. Floating composer with one-click actions, streaming answers and follow-up questions that reuse the same screenshot.
5. A cloud API that:
   - authenticates users (Firebase Authentication)
   - enforces per-user daily quotas (Firestore) and rate limits
   - validates uploads
   - routes the request to a vision-capable AI provider
   - streams the result back over Server-Sent Events
6. Secrets never shipped in the client, screenshots never stored, and a visible notice before any upload.
7. Latency measured per stage (capture, OCR, upload, first token, total) to evaluate performance.

## 3. Project planning and workflow

| Phase | Work | Output |
|---|---|---|
| 1 | Electron shell, global hotkeys, tray, pre-created overlay windows | App starts in the tray; hotkey opens the overlay |
| 2 | Drawing tools, region move/resize, undo/redo, masks, blur | Overlay test passes at 1.5× DPI |
| 3 | Physical-pixel cropping, PNG/JPEG size control, local OCR | Crops + OCR text with confidence |
| 4 | Panel: composer, quick actions, streaming Markdown, follow-ups | End-to-end answer in the panel |
| 5 | Cloud API: auth, quotas, validation, provider routing, SSE; Firebase + Render deployment | Public HTTPS API |
| 6 | Latency instrumentation + CSV log | Measured results (§8) |
| 7 | Security hardening + tests | 13 backend tests, 2 Electron E2E tests |
| 8 | Documentation, report, demo | README, this report |

## 4. Cloud service selection

| Need | Service chosen | Why this service (and not something else) |
|---|---|---|
| User identity | **Firebase Authentication** (email/password) | Managed and free. Issues short-lived signed ID tokens (JWT, 1 h) that the backend verifies with Google's public keys, so no password database is needed. |
| Per-user quota and usage | **Cloud Firestore** | Serverless document DB with **transactions**: the quota check-and-increment is atomic, so concurrent requests cannot exceed the limit. Stores only counters, never content. Free tier. |
| Running the API | **Render Web Service** (free), container-ready for **Google Cloud Run** | Managed HTTPS with automatic TLS certificates, zero-ops deploys from Git, secret environment variables and health checks. Cloud Run needs a billing account; the same Dockerfile runs there unchanged. |
| AI inference | **Google Gemini API** | Multimodal (reads screenshots), streams tokens, supports Google Search grounding, and has a free tier. Called only from the backend. |
| Secrets | Host **secret environment variables** (Render env / Cloud Run + Secret Manager) | Keys live only on the server and never enter the repo or the client. |
| Monitoring | Render logs/metrics + structured JSON logs | Every request logs id, user id, model, outcome, first-token and total latency. No content is logged. |

We deliberately did **not** add a database for conversations or screenshots. Storing them would add privacy risk with no functional benefit.

## 5. Architecture

![Architecture](architecture.png)
_(Export the Mermaid diagram in the README to `docs/architecture.png`, e.g. via https://mermaid.live, or paste the diagram there.)_

**Components**

- **Desktop client (Windows, Electron):**
  - The *main process* owns hotkeys, screen capture, OCR, the encrypted session store and the API client.
  - The *overlay* windows (one per monitor) handle drawing.
  - The *panel* window handles conversation and settings.
  - Renderers are sandboxed and talk to the main process only through a narrow IPC bridge.
- **Cloud API (Node.js/Express):** stateless, so it scales horizontally. Middleware order:
  1. `helmet` security headers
  2. per-IP rate limit
  3. Firebase token verification
  4. per-user rate limit
  5. JSON body limit
  6. schema and image validation
  7. model capability check
  8. Firestore quota transaction
  9. provider stream → SSE
- **Firebase:** Authentication (identity) and Firestore (`usage/{uid}_{YYYY-MM-DD}` documents).
- **AI provider:** Gemini via its REST streaming endpoint. A provider registry also supports any OpenAI-compatible endpoint, so models can be added without client changes.

**Sequence (one question)**
1. The user presses Ctrl+Shift+Space. The client captures all monitors (physical pixels) and shows the frozen screen in the overlays.
2. The user circles a diagram and presses Enter. The crops go to the panel, which shows thumbnails at once while OCR runs locally.
3. The user clicks **Explain**. The panel shows "Sends 1 image + OCR text + your question to Google Gemini".
4. The main process gets a fresh ID token (refreshing it if needed) and sends `POST /v1/ask` over HTTPS.
5. The API verifies the token, validates the request, reserves quota in a transaction, and opens a Gemini stream.
6. Tokens flow back as `delta` events. The panel renders Markdown as it arrives. `done` carries token usage and server timings.
7. The user's follow-up question reuses the same image; there is no recapture.

## 6. Implementation details

| Feature | How it is implemented |
|---|---|
| Overlay never in the screenshot | Capture happens *before* the overlay is shown, and the overlay paints the frozen image. |
| Correct crops under display scaling | Each display is captured at `bounds × scaleFactor`. Crops map CSS coordinates by `k = physicalWidth / cssWidth`. Verified by an automated test at 1.5× scaling. |
| Fast overlay | Overlay windows are pre-created per display and reused. The raw BGRA bitmap is sent over IPC (no PNG encode), and the window is shown only after the first paint (no black flash). |
| Freehand lasso / ellipse mask | Canvas path with an even-odd fill whites out pixels outside the shape inside the bounding box. |
| Blur tool | Pixelation (downscale ×14 → upscale without smoothing) is applied to the pixels before the crop is encoded, so the hidden data never leaves the PC. |
| Image size control | PNG is used if it is ≤ 3.5 MB. Otherwise JPEG at q90, then progressive downscaling. The server enforces 4 MB and 4 images. |
| Text-only optimisation | For *Define* and *Translate* with OCR confidence ≥ 80 %, the image is not uploaded (text only). These answers are cached in memory. |
| Obsolete requests | A new question aborts the previous HTTP stream. A client disconnect aborts the upstream Gemini call. |
| Follow-up context | Screen context is attached to the first user turn inside the history window (configurable maximum turns). |

## 7. Security implementation

**Authentication**
- Firebase ID tokens are verified on every request with `verifyIdToken(token, checkRevoked=true)`.
- Expired tokens get `401 token_expired`. The client then refreshes and retries once.

**Authorization and access control**
- Quotas and usage are keyed by the *verified* uid, never by a client-supplied id.
- Firestore security rules deny all client reads and writes. Only the backend service account can write.

**Secret management**
- The Gemini key and the service-account JSON exist only as host secret environment variables.
- `.gitignore` blocks `.env` and `serviceAccount*.json`.
- The desktop app contains no secrets (the Firebase web key is a public identifier).

**Client hardening**
- The refresh token is encrypted with DPAPI (`safeStorage`). The ID token is kept only in memory.
- Renderers run with `contextIsolation`, `sandbox`, no Node, and a strict CSP. In-app navigation is blocked, and only `https:` links open externally.
- IPC handlers check the sender.

**Input validation**
- Body ≤ 12 MB, ≤ 24 messages, ≤ 20 000 characters each, ≤ 4 images of ≤ 4 MB.
- PNG/JPEG/WebP only, checked by **file signature**, so a fake "PNG" containing SVG/HTML is rejected (unit-tested).

**Abuse protection**
- Per-IP limit (120/min) before auth and per-user limit (20/min) after auth.
- Daily quota (100 requests) via a Firestore transaction.
- 90 s upstream timeout.

**Transport**
- HTTPS (TLS by the platform). The client refuses non-HTTPS backends except localhost.
- `helmet` headers; `x-powered-by` is off.

**Privacy**
- Nothing is stored. Logs never contain prompts, OCR text or images.
- An explicit pre-send notice, a blur tool, and a local-only mode.

**Safe development mode**
- `AUTH_DISABLED` exists for local testing. The server refuses to start with it in production or on a public interface.

## 8. Results

### 8.1 Functional tests (automated)

| Test | Result |
|---|---|
| Backend: validation (MIME spoofing, oversize, roles, empty) + auth enforcement (missing/forged token → 401, security headers), 13 tests | ✅ all pass |
| Desktop: SSE parser (split chunks, CRLF), 2 tests | ✅ |
| Overlay E2E at 1.5× scaling: draw rect + ellipse, arrow, blur, lasso + undo, move region; crops at physical resolution (449×299 ≈ 300×200 × 1.5) | ✅ |
| Panel E2E against the live API + Gemini: local OCR reads code from a screenshot, "Fix error" returns corrected code, a follow-up ("what would it print last?") is answered correctly from the same screenshot without recapture | ✅ |

### 8.2 Latency (measured)

| Stage | Measured | Notes |
|---|---|---|
| Local OCR (small code snippet, 420×90 px) | 0.72 – 0.90 s | tesseract.js, warm worker |
| Upload size (1 PNG crop + OCR text + question) | 3 KB | only the crop is sent, not the full screen |
| Server pre-processing (auth + validation + quota) | ≈ 1 ms (dev, in-memory quota) | _fill in with Firestore from the deployed API logs_ |
| Time to first token (Gemini flash-lite) | 15.8 – 20.4 s | measured during a Gemini "high demand" period; the larger model returned HTTP 503 (shown to the user as a retryable error) |
| Total response time | 16.0 – 20.5 s | short answers; streaming starts showing text at first token |
| Screen capture + overlay | _fill in from latency.csv_ | depends on monitor resolution |

Interpretation: client-side work (capture, OCR, upload) is around a second. Almost all waiting is model inference at the provider, which varies with provider load. Streaming and the per-stage timing line make that visible to the user instead of hiding it.

_Add screenshots: the overlay with regions, the panel with an answer, the Firebase Auth users list, the Firestore `usage` documents, the Render dashboard/logs._

## 9. Conclusion

IntelliPointer AI cuts "see something → get an AI answer" to one hotkey, one drag and one click, with a floating answer that does not require switching applications. The cloud side shows a secure multi-service design:
- managed identity (Firebase Auth)
- a transactional quota store (Firestore)
- a stateless, horizontally scalable HTTPS API on a managed platform
- server-only secrets
- defence in depth: validation, two rate limiters, quotas, a strict client sandbox

Selecting text in any application also pops up an Ask bar (read via Windows UI Automation, without stealing focus), so text questions take only a selection and one click.

Future work:
- Windows' built-in OCR engine
- more providers through the existing registry
- a signed installer
- moving to Cloud Run with Secret Manager when billing is available

## 10. References

1. Electron documentation: `desktopCapturer`, `safeStorage`, `globalShortcut`, security checklist. https://www.electronjs.org/docs
2. Firebase Authentication REST API and Admin SDK `verifyIdToken`. https://firebase.google.com/docs/auth
3. Cloud Firestore transactions and security rules. https://firebase.google.com/docs/firestore
4. Gemini API: `streamGenerateContent`, image input, Google Search grounding. https://ai.google.dev/gemini-api/docs
5. Render Blueprint specification. https://render.com/docs/blueprint-spec
6. Tesseract.js. https://github.com/naptha/tesseract.js
7. OWASP API Security Top 10 (2023). https://owasp.org/API-Security/

---

## Appendix A: HMI mini-project evaluation (reuse for the HMI submission)

**Design principles applied**
- **Fitts's law:** the panel opens next to the selection; quick actions are one click; the toolbar moves away from the cursor.
- **Hick's law:** 5 quick actions on the overlay toolbar, the full set (9) in the panel.
- **Feedback:** live dimming, numbered regions, size labels, and a status chain of OCR → "Uploading…" → streaming cursor → timing line.
- **Error prevention and recovery:** undo/redo, Esc everywhere, Retry, Stop, and a privacy notice before sending.
- **User control:** pin/unpin, collapse, local-only mode, choice to send the image or only the text.
- **Not stealing focus:** a quick action opens the panel without taking keyboard focus.

**Usability test plan** (5–8 participants)

| Task | Baseline (manual: screenshot → chatbot → paste → type) | With IntelliPointer |
|---|---|---|
| T1: Explain an error message on screen | _time_ | _time_ |
| T2: Compare two charts | _time_ | _time_ |
| T3: Translate a paragraph | _time_ | _time_ |

Record the completion time, the number of errors, and a System Usability Scale (SUS) questionnaire per participant. Each of the 10 standard SUS items is scored 1–5. SUS score = 2.5 × (Σ(odd item − 1) + Σ(5 − even item)); above 68 is above average.
