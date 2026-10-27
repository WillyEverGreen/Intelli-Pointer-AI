# Deployment guide

Two supported targets. Use **Render** if you have no billing account (free
tier); use **Google Cloud Run** if you have one (no key files, Secret Manager).
Both run the same code from `backend/`.

Prerequisites: a Google account, a GitHub account, and a Gemini API key from
<https://aistudio.google.com/apikey>.

## 1. Firebase project (both targets)

1. <https://console.firebase.google.com> → **Add project** (Analytics off). Note the **Project ID**.
2. **Build → Authentication → Sign-in method → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** (production mode, any region).
4. **Firestore → Rules:** paste `firebase/firestore.rules` and **Publish**. (Or `firebase deploy --only firestore:rules` from the repo root.) The rules deny every client; only the backend writes.
5. **Project settings → General → Web API key.** This is public by design and goes into the desktop app.
6. Render only: **Project settings → Service accounts → Generate new private key.** Keep the JSON secret. (Not needed on Cloud Run.)

## 2a. Render (free)

1. Push the repository to GitHub (private is fine).
2. Render → **New → Blueprint** → select the repo (it reads `render.yaml`).
3. Enter the secret variables when asked:

   | Variable | Value |
   |---|---|
   | `FIREBASE_PROJECT_ID` | from step 1 |
   | `FIREBASE_SERVICE_ACCOUNT_JSON` | the JSON from step 1.6, on one line (or base64) |
   | `GEMINI_API_KEY` | your Gemini key |

4. After the deploy, open `https://<service>.onrender.com/healthz`. Expect `{"ok":true,"providers":true,"quota":"firestore"}`.

The free tier sleeps when idle and takes up to a minute to wake: open `/healthz` before a demonstration.

## 2b. Google Cloud Run (no key files)

```bash
PROJECT=<your-firebase-project-id>
REGION=asia-south1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com firestore.googleapis.com

# Secret Manager holds the only secret
printf %s "<your-gemini-key>" | gcloud secrets create gemini-key --data-file=-

# Deploy straight from source (uses backend/Dockerfile)
gcloud run deploy intellipointer-api --source backend --region $REGION \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=$PROJECT,NODE_ENV=production,TRUST_PROXY=1 \
  --set-secrets GEMINI_API_KEY=gemini-key:latest

# Least privilege for the runtime identity: Firestore + that one secret
SA=$(gcloud run services describe intellipointer-api --region $REGION --format='value(spec.template.spec.serviceAccountName)')
gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA" --role="roles/datastore.user"
gcloud secrets add-iam-policy-binding gemini-key --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
```

`--allow-unauthenticated` only means Cloud Run does not add its own login in
front; **every `/v1/*` call still requires a valid Firebase ID token**
(verified by the app, with revocation checks). Cloud Run sets `K_SERVICE`, so
the backend automatically uses the platform's credentials for Firestore.
Check the flags against the current `gcloud run deploy` reference before you run them.

Scaling: Cloud Run starts more instances under load; the service is stateless
and the daily quota is in Firestore, so instances share it. Add
`--min-instances 1` to avoid cold starts and `--max-instances N` to cap cost.

## 3. Verify the deployment and collect evidence

```bash
cd backend
node scripts/verify-deployment.mjs --url https://<your-service-url> \
     --firebase-key <web API key> --email you@example.com --password '<password>' --create
```

It checks HTTPS, health and cold-start time, security headers, that
unauthenticated and forged requests get 401, Firebase sign-in, the model list,
a streamed answer (first-token and total latency), the Firestore usage counter,
image validation (415) and the size limit (413). It writes
`docs/evidence/deployment-<time>.json` and a Markdown table for the report.
Take screenshots of the Firebase **Authentication → Users** page, the
**Firestore → usage** documents, and the Render or Cloud Run dashboard and logs
next to it.

## 4. Point the desktop app at it

Settings → Models → **Cloud**: enter the backend URL and the Firebase web API
key, then create an account or sign in, and switch the Cloud source on.

## 5. Day-two operations

| Task | How |
|---|---|
| Change quota or limits | Set `DAILY_REQUEST_LIMIT`, `RATE_LIMIT_PER_MINUTE` on the service; redeploy |
| Add models | `GEMINI_MODELS`, or `OPENAI_COMPAT_*` (see `backend/.env.example`) |
| Rotate the Gemini key | Create a new key; update the secret; redeploy; delete the old key |
| Disable a user | Firebase console → Authentication → disable; effective on their next request |
| Read logs | Render → Logs, or Cloud Logging (`jsonPayload.msg="ask"`): request id, user id, model, outcome, latencies |
| Roll back | Render → Deploys → redeploy a previous build; Cloud Run → Revisions → route traffic |
| Run all tests | `cd backend && npm run test:all` (needs Java 21 for the Firestore emulator) |

## Environment variables

See `backend/.env.example` for the full list with comments.
