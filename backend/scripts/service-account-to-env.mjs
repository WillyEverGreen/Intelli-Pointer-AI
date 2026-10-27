// Stores a downloaded Firebase service-account key in backend/.env as base64,
// WITHOUT printing it, then offers to delete the downloaded file.
//   npm run env:service-account -- "C:\Users\you\Downloads\intellipointer-10707-firebase-adminsdk-xxxx.json"
// Add --delete to remove the downloaded JSON afterwards (recommended: the
// only copy should be the one in .env and in Render's environment).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const remove = args.includes('--delete');
const envFile = process.env.IP_ENV_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (!file || !fs.existsSync(file)) {
  console.error('Usage: npm run env:service-account -- <path to the downloaded key .json> [--delete]');
  process.exit(2);
}
let sa;
try {
  sa = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  console.error('That file is not valid JSON.');
  process.exit(1);
}
if (sa.type !== 'service_account' || !sa.private_key || !sa.client_email) {
  console.error('That is not a Firebase service-account key.');
  process.exit(1);
}

const value = Buffer.from(JSON.stringify(sa)).toString('base64');
let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
if (/^FIREBASE_SERVICE_ACCOUNT_JSON=.*$/m.test(env)) env = env.replace(/^FIREBASE_SERVICE_ACCOUNT_JSON=.*$/m, () => `FIREBASE_SERVICE_ACCOUNT_JSON=${value}`);
else env += `${env.endsWith('\n') || !env ? '' : '\n'}FIREBASE_SERVICE_ACCOUNT_JSON=${value}\n`;
fs.writeFileSync(envFile, env);

console.log(`Saved the key for project "${sa.project_id}" (${sa.client_email}) into backend/.env.`);
if (remove) {
  fs.rmSync(file, { force: true });
  console.log('Deleted the downloaded file.');
} else {
  console.log('Tip: delete the downloaded file now (or re-run with --delete). Never commit it or paste it anywhere.');
}
