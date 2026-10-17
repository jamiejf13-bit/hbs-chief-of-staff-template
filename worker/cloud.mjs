// The half of the worker that does not need the owner's laptop.
//
//   node worker/cloud.mjs
//
// Canvas, Gmail, Google Calendar and the job boards are plain HTTPS calls
// against APIs with tokens. Nothing here opens a browser, reads a file on the
// laptop, or acts on your behalf — so it can run anywhere, on a schedule, and
// keep the phone view current while the laptop is shut.
//
// WHAT DELIBERATELY STAYS ON THE LAPTOP
//
//   outlook     HBS gives no API. The only way in is a signed-in browser
//               profile, and that profile cannot leave the machine.
//   12twenty    The same, plus registration clicks a real button.
//   tracker     The Class Log is an .xlsx in a local OneDrive folder.
//   reconcile   It judges Outlook against Google; without a fresh Outlook
//               read it would call every Outlook event missing.
//   actions     Everything that changes something outward. Some of it could
//               run here, but splitting the executor across two machines
//               means two processes racing for the same approved rows, and
//               the thing they race over is your real calendar.
//
// So this is read-only by construction. If a future source needs a browser or
// a file, it belongs in loop.mjs, not here.

import { loadEnv, db, log, markSource } from './lib.mjs';
import { syncGoogleCalendar } from './gcal.mjs';
import { syncCanvas } from './canvas.mjs';
import { syncGmail } from './gmail.mjs';
import { syncJobBoards } from './jobs.mjs';

const JOBS = [
  { name: 'gcal', run: (sql, env, did) => syncGoogleCalendar(sql, env, did) },
  { name: 'canvas', run: (sql, env, did) => syncCanvas(sql, env, did) },
  { name: 'gmail', run: (sql, env, did) => syncGmail(sql, env, did) },
  /**
   * The job boards read about 2,500 postings across six boards and change
   * slowly, so they run on their own schedule rather than every pass. The
   * caller decides: `--only gcal,canvas` from the fast workflow, everything
   * from the slow one.
   */
  { name: 'jobs', run: (sql, env, did) => syncJobBoards(sql, env, did) },
];

const only = (() => {
  const i = process.argv.indexOf('--only');
  if (i === -1) return null;
  return new Set((process.argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
})();

const env = loadEnv();
const sql = db(env);
const did = [];
const results = {};
let failed = 0;

log('cloud worker starting', only ? `(only: ${[...only].join(', ')})` : '(all sources)');

for (const job of JOBS) {
  if (only && !only.has(job.name)) continue;
  try {
    results[job.name] = await job.run(sql, env, did);
    log(`${job.name}:`, JSON.stringify(results[job.name]));
    if (results[job.name]?.ok === false) failed++;
  } catch (err) {
    // One source failing must never stop the others — the whole reason this
    // exists is that the laptop is an unreliable place to run anything.
    failed++;
    log(`${job.name} threw:`, err.message);
    did.push(`${job.name} FAILED — ${String(err.message).slice(0, 160)}`);
    try { await markSource(sql, job.name, false, err.message); } catch { /* db may be down too */ }
  }
}

/**
 * Its own heartbeat column, never the laptop's.
 *
 * Writing the shared beat here would make a laptop that died at midnight look
 * alive all night, because something somewhere was still running. The page
 * tells you which half is down, and it can only do that if the two halves
 * report separately.
 */
await sql`
  update worker_heartbeat
     set cloud_beat_at = now(),
         cloud_note = ${did.length ? did.slice(0, 3).join(' · ').slice(0, 300) : 'no changes'}
   where id = true`;

for (const line of did) log('  ·', line);
log(`cloud worker done — ${failed} source${failed === 1 ? '' : 's'} failed`);

// A non-zero exit makes GitHub mark the run red, which is the only way you
// would ever find out that the cloud half has been failing quietly for a week.
process.exit(failed ? 1 : 0);
