// One worker pass.
//
//   node worker/run.mjs
//
// Runs every enabled source once, records what it did, and beats the
// heartbeat. A source that fails marks itself and does not stop the others —
// 12Twenty failing must never stop the Canvas sync (spec §8).
//
// The continuous loop, the Outlook browser source and the action executor
// come next. This is deliberately a single pass so it can be run by hand and
// watched before anything is scheduled.

import { loadEnv, db, log, recordRun, heartbeat } from './lib.mjs';
import { syncCanvas } from './canvas.mjs';
import { syncOutlook } from './outlook.mjs';
import { reconcileCalendars } from './reconcile.mjs';
import { syncGoogleCalendar, mirrorOutlookToGoogle } from './gcal.mjs';

const env = loadEnv();
const sql = db(env);
const did = [];

log('worker pass starting');

const results = {};

try {
  results.canvas = await syncCanvas(sql, env, did);
  log('canvas:', JSON.stringify(results.canvas));
} catch (err) {
  log('canvas threw:', err.message);
  did.push(`Canvas FAILED — ${err.message}`);
}

// Outlook runs after Canvas deliberately: it is the slow, fragile one, and a
// browser failure must never cost us the assignments (spec §8).
try {
  results.outlook = await syncOutlook(sql, env, did);
  log('outlook:', JSON.stringify(results.outlook));
} catch (err) {
  log('outlook threw:', err.message);
  did.push(`Outlook FAILED — ${err.message}`);
}

// Google Calendar: second calendar source, and the only writable one.
try {
  results.gcal = await syncGoogleCalendar(sql, env, did);
  log('gcal:', JSON.stringify(results.gcal));
} catch (err) {
  log('gcal threw:', err.message);
  did.push(`Google Calendar FAILED — ${err.message}`);
}

// Reconcile only after the calendar sources have had their turn.
try {
  results.reconcile = await reconcileCalendars(sql, did);
  log('reconcile:', JSON.stringify(results.reconcile));
} catch (err) {
  log('reconcile threw:', err.message);
  did.push(`Reconcile FAILED — ${err.message}`);
}

// Tier 1: copy Outlook-only events into Google, silently but logged.
try {
  results.mirror = await mirrorOutlookToGoogle(sql, env, did);
  log('mirror:', JSON.stringify(results.mirror));
} catch (err) {
  log('mirror threw:', err.message);
  did.push(`Mirror FAILED — ${err.message}`);
}

await recordRun(sql, did);
await heartbeat(sql, 'run.mjs single pass');

const [{ n: open }] = await sql`select count(*)::int as n from tasks where done = false and deleted_at is null`;
const [{ n: total }] = await sql`select count(*)::int as n from tasks where deleted_at is null`;

log(`done — ${open} open of ${total} tasks`);

if (did.length) {
  console.log('\nWhat this pass did:');
  for (const line of did) console.log(`  · ${line}`);
} else {
  console.log('\nNothing changed.');
}
