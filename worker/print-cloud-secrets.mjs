// Prints the five values the cloud half needs, for pasting into GitHub.
//
//   node worker/print-cloud-secrets.mjs
//
// GitHub > the repo > Settings > Secrets and variables > Actions > New
// repository secret. One per name below.
//
// These are real credentials. They are printed to this terminal and nowhere
// else — never committed, never logged, never sent anywhere. Close the window
// when you are done, and if you ever paste one somewhere public, rotate it:
// the Google pair in the Cloud console, Canvas under Account > Settings.

import { readFileSync } from 'node:fs';
import { loadEnv, googleRefreshToken } from './lib.mjs';

const env = loadEnv();
const values = {
  DATABASE_URL: env.DATABASE_URL,
  CANVAS_TOKEN: env.CANVAS_TOKEN,
  GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN: googleRefreshToken(env),
};

/**
 * Name one secret to print only that one.
 *
 *   node worker/print-cloud-secrets.mjs                       all five
 *   node worker/print-cloud-secrets.mjs GOOGLE_REFRESH_TOKEN  just that one
 *
 * Re-pasting a single secret is the common case: GitHub will not show you one
 * after it is saved, so a value that did not take can only be replaced, never
 * inspected. Putting the other four back on screen to fix one of them is
 * exposure for nothing.
 */
const want = (process.argv[2] ?? '').trim().toUpperCase();
if (want && !(want in values)) {
  console.log(`\nNo secret called "${want}". The five are:\n  ${Object.keys(values).join('\n  ')}\n`);
  process.exit(1);
}

const show = want ? { [want]: values[want] } : values;

console.log(want
  ? `\nPaste this as the repository secret ${want}:\n`
  : '\nAdd these five as repository secrets, exactly as named:\n');

for (const [k, v] of Object.entries(show)) {
  if (!v) { console.log(`  ${k}\n    !! MISSING — the cloud half will fail without it\n`); continue; }
  console.log(`  ${k}`);
  console.log(`    ${v}`);
  // The length is the only way to check a paste landed whole without being
  // able to read the secret back out of GitHub afterwards.
  console.log(`    ^ ${v.length} characters — GitHub should report the same after you save\n`);
}
console.log('Then: Actions > Sync > Run workflow, to check it before trusting the schedule.\n');
