// One-time Google consent, then a saved refresh token.
//
//   node worker/google-auth.mjs
//
// Starts a tiny local server, prints a URL, and waits. Open the URL, pick
// your Google account (emails.personal in lib/profile.json), click through the "unverified app" warning (it is your
// own app), and approve. The token lands in worker/.credentials/google-token.json,
// which is gitignored and never leaves this laptop.
//
// Uses the loopback redirect Google reserves for Desktop clients, so no
// domain, no HTTPS, and no browser automation is involved.

import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { loadEnv } from './lib.mjs';
import { PROFILE } from './profile.mjs';

const TOKEN_PATH = fileURLToPath(new URL('./.credentials/google-token.json', import.meta.url));

const env = loadEnv();

/**
 * Ask for the narrowest scope set that does the job today.
 *
 * `calendar` is a *sensitive* scope. `gmail.readonly` is a *restricted* one,
 * and the difference matters: a production app using a restricted scope needs
 * an annual paid third-party security assessment. A Testing-mode app does not.
 *
 * Nothing in the worker reads mail yet, so asking for it buys nothing and
 * costs the option to publish. To turn it on later, put
 *
 *   GOOGLE_GMAIL_SCOPE=true
 *
 * in .env.local and re-run this script — Google will re-prompt for consent and
 * mint a token covering both. See docs/google-setup.md for what that forecloses.
 */
const WANT_GMAIL = /^(1|true|yes)$/i.test(env.GOOGLE_GMAIL_SCOPE ?? '');

/**
 * `drive.file` uploads the class prep write-ups so they open as Google Docs.
 *
 * Deliberately `drive.file` and not `drive`. `drive.file` grants access only to
 * files this app itself creates — it cannot see, read or touch anything else in
 * your Drive, which matters because the alternative is handing a background
 * worker your entire document store to upload a .docx. It is also a
 * non-sensitive scope, so unlike gmail.readonly it forecloses nothing.
 *
 * Turn it on with GOOGLE_DRIVE_SCOPE=true in .env.local and re-run this script.
 */
const WANT_DRIVE = /^(1|true|yes)$/i.test(env.GOOGLE_DRIVE_SCOPE ?? '');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar', // read + write events
  ...(WANT_GMAIL ? ['https://www.googleapis.com/auth/gmail.readonly'] : []),
  ...(WANT_DRIVE ? ['https://www.googleapis.com/auth/drive.file'] : []),
];
if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
  console.error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing from .env.local');
  process.exit(1);
}

mkdirSync(fileURLToPath(new URL('./.credentials/', import.meta.url)), { recursive: true });

// PKCE — required for installed apps, and it means the code alone is useless
// to anyone who intercepts the redirect.
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }

  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');

  const reply = (msg) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${PROFILE.appName}</title>
      <body style="font:16px system-ui;padding:3rem;max-width:32rem">
      <h1 style="font-size:1.2rem">${msg}</h1>
      <p style="color:#666">You can close this tab and go back to Claude.</p>`);
  };

  if (err) { reply(`Google returned an error: ${err}`); finish(new Error(err)); return; }
  if (!code) { reply('No authorisation code came back.'); return; }
  if (gotState !== state) { reply('State mismatch — ignoring this response.'); return; }

  try {
    const body = new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tok = await r.json();

    if (!r.ok || !tok.refresh_token) {
      reply('Token exchange failed — check the terminal.');
      finish(new Error(tok.error_description || tok.error || 'no refresh_token returned'));
      return;
    }

    writeFileSync(
      TOKEN_PATH,
      JSON.stringify({ refresh_token: tok.refresh_token, scope: tok.scope, obtained: new Date().toISOString() }, null, 2),
    );
    reply(`Connected. ${PROFILE.appName} can now read your calendar${WANT_GMAIL ? ' and mail' : ''}.`);
    finish(null, tok.scope);
  } catch (e) {
    reply('Something went wrong — check the terminal.');
    finish(e);
  }
});

let redirectUri;

function finish(error, scope) {
  setTimeout(() => {
    server.close();
    if (error) {
      console.error(`\nFAILED: ${error.message}`);
      if (/deleted_client|invalid_client/.test(error.message)) {
        console.error('That usually means GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is wrong.');
      }
      process.exit(1);
    }
    console.log(`\nSaved refresh token to worker/.credentials/google-token.json`);
    console.log(`Scopes granted: ${scope}`);
    console.log('\nThe app is in Testing, so this token stops working after 7 days.');
    console.log('Re-run this script when the dashboard says Google needs reconnecting.');
    process.exit(0);
  }, 400);
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  redirectUri = `http://localhost:${port}`;

  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', SCOPES.join(' '));
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent'); // force a refresh_token every time
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('state', state);

  console.log(`Open this in your browser, signed in as ${PROFILE.emails?.personal ?? 'your Google account'}:\n`);
  console.log(auth.toString());
  console.log('\nYou will see an "unverified app" warning — that is your own app.');
  console.log(`Click Advanced, then "Go to ${PROFILE.appName} (unsafe)", then Continue.`);
  console.log('\nWaiting...');
});

setTimeout(() => {
  console.error('\nTimed out after 10 minutes. Nothing saved — rerun when ready.');
  process.exit(1);
}, 10 * 60_000);
