// Put the current Google refresh token on the clipboard, and nowhere else.
//
//   node scripts/copy-google-token.mjs
//
// WHY THIS EXISTS. There are two copies of this token. The laptop reads
// worker/.credentials/google-token.json, which `worker/google-auth.mjs`
// rewrites every time you reconnect. The cloud half reads a
// GOOGLE_REFRESH_TOKEN secret in GitHub Actions, which nothing on the laptop
// can touch — so reconnecting fixed the laptop, the next cloud run marked
// Google broken again, and the banner came back every few hours for weeks.
//
// Updating the GitHub secret is the fix, and it needs the token in the
// clipboard without it appearing in a chat window, a terminal history or a
// file on disk. So: clipboard only, and the value is never printed.
//
// `powershell -c Set-Clipboard` does NOT work here, which is how the first
// attempt failed silently — Set-Clipboard takes -Value or pipeline input and
// ignores stdin from a pipe. clip.exe reads stdin, which is what is wanted.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOKEN = fileURLToPath(new URL('../worker/.credentials/google-token.json', import.meta.url));

let stored;
try {
  stored = JSON.parse(readFileSync(TOKEN, 'utf8'));
} catch (err) {
  console.error(`Could not read ${TOKEN}`);
  console.error(String(err.message));
  console.error('\nRun "node worker/google-auth.mjs" first to create it.');
  process.exit(1);
}

const token = String(stored.refresh_token ?? '').trim();
if (!token) {
  console.error('That file has no refresh_token in it.');
  process.exit(1);
}

try {
  // No trailing newline: clip.exe passes stdin through verbatim, and a stray
  // newline pasted into a GitHub secret is invisible and breaks the token.
  execFileSync('clip', [], { input: token });
} catch (err) {
  console.error(`Could not reach the clipboard: ${String(err.message).slice(0, 80)}`);
  process.exit(1);
}

// Confirmed by reading the clipboard back, not by assuming the write worked —
// and compared by length and ending, so the value itself is never shown.
let ok = false;
try {
  const back = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], {
    encoding: 'utf8',
  }).replace(/\r?\n$/, '');
  ok = back === token;
} catch {
  /* reading back is a nicety; the copy may still have worked */
}

console.log(`Copied the Google refresh token to your clipboard.`);
console.log(`  ${token.length} characters, obtained ${stored.obtained?.slice(0, 16).replace('T', ' ') ?? 'unknown'}`);
console.log(`  verified on the clipboard: ${ok ? 'yes' : 'could not confirm — paste and check it is not empty'}`);
console.log('');
console.log('Now paste it into GitHub:');
console.log('  Settings -> Secrets and variables -> Actions -> GOOGLE_REFRESH_TOKEN -> Update');
console.log('');
console.log('Paste with nothing after it. A trailing space or newline is invisible and will fail.');
