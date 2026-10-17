// Shared worker plumbing: settings, database handle, logging.
//
// The worker writes to Neon directly rather than through /api/worker/push.
// The spec's push design exists so the laptop need not hold the database
// credential — but it already does, in .env.local, and nothing is deployed
// yet, so a direct write is the same trust boundary with fewer moving parts.
// Revisit when the app goes to Vercel.

import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Configuration, from `.env.local` on the laptop or the environment in CI.
 *
 * The cloud half of the worker runs where there is no `.env.local` and never
 * will be — its secrets arrive as environment variables. This used to exit
 * with ".env.local not found", which is the right answer on the laptop
 * and the wrong one everywhere else.
 *
 * The file wins where it defines a key, so nothing about running on the
 * laptop changes; the environment fills the gaps and supplies everything when
 * there is no file at all.
 */
export function loadEnv() {
  const url = new URL('../.env.local', import.meta.url);
  let raw = '';
  try {
    raw = readFileSync(url, 'utf8');
  } catch {
    if (!process.env.DATABASE_URL) {
      fail('No .env.local and no DATABASE_URL in the environment — nothing to connect to.');
    }
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const out = { ...process.env };
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

export function db(env) {
  if (!env.DATABASE_URL) fail('DATABASE_URL is not set.');
  return neon(env.DATABASE_URL);
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Run one statement verbatim. This driver exposes only the tagged form. */
export function raw(sql, statement) {
  const s = [statement];
  s.raw = [statement];
  return sql(s);
}

/**
 * Record how a source ended up, every run, success or failure.
 * A source that fails must say so on the dashboard rather than going quiet —
 * a silent 12Twenty failure means missed recruiting deadlines (spec §8).
 */
/**
 * Record how a source just did — and create its row if it has none.
 *
 * This was a bare UPDATE, so a source whose row had never been seeded updated
 * nothing at all and said nothing about it. 'outlook-mail' reported health on
 * every pass, succeeded and failed, and never once appeared in Sources: the
 * update matched zero rows and returned quietly. Callers wrap this in a catch
 * because the database may be the thing that is broken, which means a silent
 * no-op here is indistinguishable from working.
 *
 * A source whose health is invisible is the one that dies unnoticed, which is
 * the entire thing Sources exists to prevent.
 */
export async function markSource(sql, name, ok, error = null, warning = null) {
  if (ok) {
    // `warning` is for a source that is working and will not be for long —
    // the 12Twenty sign-in nearing its thirty-six hours. Set on the ok path so
    // the prompt can arrive while things still work, rather than as an error
    // after they stop. Cleared on every pass, like last_error, so a warning
    // that no longer applies cannot linger.
    await sql`
      insert into sources (name, status, last_sync_at, last_error, warning)
      values (${name}, 'ok', now(), null, ${warning})
      on conflict (name) do update
        set status = 'ok', last_sync_at = now(), last_error = null,
            warning = ${warning}`;
  } else {
    const why = String(error).slice(0, 500);
    await sql`
      insert into sources (name, status, last_error)
      values (${name}, 'error', ${why})
      on conflict (name) do update
        set status = 'error', last_error = excluded.last_error`;
  }
}

export async function recordRun(sql, did, nextRunAt = null) {
  if (!did.length) return;
  await sql`insert into agent_runs (did, next_run_at) values (${did}, ${nextRunAt})`;
}

/**
 * When this process started, and the newest worker file it loaded.
 *
 * Node caches modules at import, so a worker started this morning keeps
 * running this morning's code no matter what is edited underneath it. That is
 * how a register handler written at 19:43 was missing from a worker started at
 * 19:05, and the page had no way to say so.
 */
const STARTED_AT = new Date();
const CODE_AT = newestWorkerFile();

function newestWorkerFile() {
  try {
    const dir = fileURLToPath(new URL('./', import.meta.url));
    return Math.max(...readdirSync(dir)
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => statSync(join(dir, f)).mtimeMs));
  } catch {
    return 0;
  }
}

/**
 * Has a worker file changed since this process imported them?
 *
 * The heartbeat has always computed this to drive the console's banner. It is
 * exported so the loop can act on it instead of only reporting it — being told
 * to restart the worker by hand, repeatedly, is the thing worth removing.
 */
export function codeHasChanged() {
  return newestWorkerFile() > CODE_AT + 1000;
}

export async function heartbeat(sql, note = null) {
  const stale = codeHasChanged();
  await sql`
    update worker_heartbeat
       set beat_at = now(), note = ${note},
           started_at = ${STARTED_AT.toISOString()},
           code_stale = ${stale}
     where id = true`;
}

export const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

/**
 * The Google refresh token, from the environment or from the laptop's file.
 *
 * The environment comes first so the same code runs in two places: on the
 * laptop, where google-auth.mjs wrote a file, and in the cloud runner, where
 * there is no filesystem to have written one to and the token arrives as a
 * secret. Four modules read this token and each had its own copy of the
 * readFileSync; a fifth caller in a different environment would have meant a
 * fifth copy, and eventually one of them differing.
 *
 * Never logged, never written to the database, never sent anywhere but
 * Google's token endpoint.
 */
export function googleRefreshToken(env = process.env) {
  const fromEnv = (env.GOOGLE_REFRESH_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;

  const path = fileURLToPath(new URL('./.credentials/google-token.json', import.meta.url));
  let stored;
  try {
    stored = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(
      'No Google token — set GOOGLE_REFRESH_TOKEN, or run "node worker/google-auth.mjs" on the laptop',
    );
  }
  if (!stored.refresh_token) throw new Error('Stored Google token has no refresh_token');
  return stored.refresh_token;
}

/**
 * Is a 12Twenty sign-in window open right now?
 *
 * Checked by every reader that drives that browser profile, because a profile
 * holds one instance and whichever gets there first locks the other out — and
 * the one that matters is the window the owner is typing into.
 */
export async function twelveTwentyBusy(sql) {
  try {
    const [p] = await sql`select twelvetwenty_busy_until from prefs where id = true`;
    const until = p?.twelvetwenty_busy_until ? Date.parse(p.twelvetwenty_busy_until) : 0;
    return Date.now() < until;
  } catch {
    // If this cannot be read, let the reader run. Failing closed would mean a
    // database hiccup silently stopping every 12Twenty sync.
    return false;
  }
}

/** Claim the profile for a sign-in window. */
export async function holdTwelveTwenty(sql, minutes = 10) {
  await sql`update prefs
               set twelvetwenty_busy_until = now() + (${minutes} || ' minutes')::interval
             where id = true`;
}
