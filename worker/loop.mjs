// The worker proper: runs continuously while the laptop is awake.
//
//   node worker/loop.mjs
//
// Each source has its own interval (spec §8), deliberately unequal. Cheap API
// reads run often; the browser-driven ones run rarely because they are slow
// and fragile, and 12Twenty especially must not be polled hard.
//
// Nothing here blocks on anything else. A source that throws marks itself in
// the sources table, logs to the agent run, and the others carry on — a
// failing 12Twenty must never stop the Canvas sync.

import { loadEnv, db, log, recordRun, heartbeat, markSource, codeHasChanged } from './lib.mjs';
import { syncCanvas } from './canvas.mjs';
import { syncGmail } from './gmail.mjs';
import { syncTwelveTwenty } from './twelvetwenty.mjs';
import { syncJobBoards } from './jobs.mjs';
import { syncParticipation } from './participation.mjs';
import { syncOutlook } from './outlook.mjs';
import { syncOutlookMail } from './outlook-mail.mjs';
import { syncWriteups } from './writeups.mjs';
import { syncEstimates } from './estimate.mjs';
import { syncPeople } from './people.mjs';
import { syncAlumni } from './alumni.mjs';
import { syncGoogleCalendar, mirrorOutlookToGoogle, mirrorRegisteredEvents } from './gcal.mjs';
import { reconcileCalendars } from './reconcile.mjs';
import { runApprovedActions, mirrorRegisteredToOutlook, runSignInActions } from './actions.mjs';

const MIN = 60_000;

/** When this process started, for the restart grace period below. */
const startedAt = Date.now();

/** Intervals from spec §8. 12Twenty is browser work — slow and fragile — so
 *  it runs rarely. Canvas assignments do not appear minute to minute. The
 *  action poll is fast because approvals should feel immediate.
 *
 *  The two calendars are the exception, and deliberately so: plans move
 *  around during the day, and a console showing where your afternoon
 *  was an hour ago is worse than useless for deciding what to do next.
 *  Outlook drives a browser and costs about fifteen seconds a pass, which is
 *  affordable every five minutes now that passes can no longer overlap. */
const JOBS = [
  /**
   * Google Calendar stays here as well as in the cloud, and only here does it
   * run every two minutes.
   *
   * The cloud half syncs it every fifteen, which is right for a phone and too
   * slow for the laptop: reconciliation runs here and judges Outlook against
   * Google, so a fifteen-minute-old Google read would have it reporting
   * divergence that a two-minute-old one shows does not exist. Both writes
   * are idempotent upserts keyed on the Google event id, so the overlap
   * costs a request and changes nothing.
   *
   * Canvas, Gmail and the job boards are gone from this list entirely — the
   * cloud covers them, none of them feeds reconciliation, and running them
   * twice bought nothing but two sets of API calls.
   */
  { name: 'gcal', every: 2 * MIN, run: (sql, env, did) => syncGoogleCalendar(sql, env, did) },
  { name: 'outlook', every: 5 * MIN, run: (sql, env, did) => syncOutlook(sql, env, did) },
  // Three hours, per the spec. It drives a browser, and the events list
  // barely changes within a day.
  { name: '12twenty', every: 180 * MIN, run: (sql, env, did) => syncTwelveTwenty(sql, env, did) },
  /**
   * The HBS mailbox. Browser work like the calendar, so it stays on the
   * laptop, but mail does not move minute to minute and every pass drives a
   * fresh Chromium — twenty minutes matches Gmail and costs one page load.
   */
  { name: 'outlook-mail', every: 20 * MIN, run: (sql, env, did) => syncOutlookMail(sql, env, did) },
  // Hourly. The Class Log is filled in by hand after class, so anything faster is
  // reading a file that has not changed.
  { name: 'tracker', every: 60 * MIN, run: (sql, env, did) => syncParticipation(sql, env, did) },
  /**
   * Every ten minutes, because the HBS Daily task writes these the evening
   * before class and nobody should have to wait an hour to see one. The cost
   * is a directory walk plus a read of only the documents whose mtime moved —
   * nothing is re-parsed on an unchanged pass.
   */
  { name: 'writeups', every: 10 * MIN, run: (sql, env, did) => syncWriteups(sql, env, did) },
  /**
   * Hourly, and almost always a no-op: once a task has a number it is never
   * asked about again, so this costs one request when a batch of new Canvas
   * assignments lands and nothing at all in between.
   */
  { name: 'estimates', every: 60 * MIN, run: (sql, env, did) => syncEstimates(sql, env, did) },
  /**
   * Twice a day. The mentorship directory is not a feed — people join it over
   * weeks, not minutes — and 12Twenty's bot protection reacts badly to
   * frequent automated visits, which was learned the expensive way.
   */
  { name: 'people', every: 720 * MIN, run: (sql, env, did) => syncPeople(sql, env, did) },
  /**
   * Once a day. The target is three to five contacts a day, and the job stops
   * as soon as that many exist for today — it does not even open a browser,
   * which matters because every visit is one 12Twenty's bot protection counts.
   */
  { name: 'alumni', every: 1440 * MIN, run: (sql, env, did) => syncAlumni(sql, env, did) },

  /**
   * The cloud's sources, run here only when the cloud is not running them.
   *
   * Handing these over outright would have meant Canvas and Gmail going dark
   * the moment this shipped and staying dark until the GitHub secrets were
   * added — a gap measured in however long that took, with nothing on the
   * page to explain it. So the laptop stays the backstop: while the cloud is
   * beating these are skipped, and if it stops they simply resume.
   *
   * The intervals are the cloud's, not the old laptop ones. If the laptop is
   * covering for a failed cloud run it should cover at the cadence the cloud
   * promised, not the slower one that predated it.
   */
  { name: 'canvas', every: 45 * MIN, whenCloudIsDown: true,
    run: (sql, env, did) => syncCanvas(sql, env, did) },
  { name: 'gmail', every: 20 * MIN, whenCloudIsDown: true,
    run: (sql, env, did) => syncGmail(sql, env, did) },
  { name: 'jobs', every: 360 * MIN, whenCloudIsDown: true,
    run: (sql, env, did) => syncJobBoards(sql, env, did) },
];

/**
 * Has the cloud half reported recently?
 *
 * Scheduled every fifteen minutes and GitHub is often a few minutes late, so
 * forty-five is "it has genuinely stopped" rather than "it is running late".
 * A database error answers "down", which makes the laptop do the work — the
 * safe way round to be wrong.
 */
const CLOUD_STALE_AFTER = 45 * MIN;

async function cloudIsDown(sql) {
  try {
    const [row] = await sql`select cloud_beat_at from worker_heartbeat where id = true`;
    if (!row?.cloud_beat_at) return true;
    return Date.now() - Date.parse(row.cloud_beat_at) > CLOUD_STALE_AFTER;
  } catch {
    return true;
  }
}

const RECONCILE_EVERY = 6 * MIN; // just after Outlook, so divergence is fresh
const ACTIONS_EVERY = MIN;
const HEARTBEAT_EVERY = MIN;

const env = loadEnv();
const sql = db(env);

const lastRun = new Map();
let stopping = false;

function due(name, every) {
  const last = lastRun.get(name) ?? 0;
  return Date.now() - last >= every;
}

async function guarded(name, fn, did) {
  // Claimed before it runs, not after. A job that takes longer than the tick
  // interval would otherwise still look due to the next tick, and two copies
  // of the same sync would run against the same rows.
  lastRun.set(name, Date.now());
  try {
    const result = await fn();
    lastRun.set(name, Date.now());
    return result;
  } catch (err) {
    lastRun.set(name, Date.now()); // do not hot-loop on a failing source
    log(`${name} FAILED:`, err.message);
    did.push(`${name} FAILED — ${String(err.message).slice(0, 160)}`);
    try { await markSource(sql, name, false, err.message); } catch { /* db may be down too */ }
    return { ok: false };
  }
}

/**
 * One pass at a time, always.
 *
 * `setInterval` does not wait for an async callback, and a pass that drives
 * Outlook through Playwright routinely runs past thirty seconds. Passes
 * therefore overlapped, and once — after the laptop woke and several
 * sources ran long at once — three of them reached the Outlook-to-Google
 * mirror together, read the same not-yet-mirrored rows, and created the same
 * events three times each in the real calendar.
 */
let ticking = false;

/**
 * Restart when the code underneath has changed, rather than asking you to.
 *
 * Node caches modules at import, so a worker started this morning runs this
 * morning's code whatever is edited beneath it. The console already detected
 * that and showed a banner — "the worker needs restarting" — which is a
 * recurring manual step, and a recurring manual step is a bug.
 *
 * Exiting is enough: the scheduled task repeats every ten minutes with
 * MultipleInstances=IgnoreNew, so it skips while a worker is alive and starts
 * a fresh one the moment there is not. The heartbeat and wedged-tick guards
 * already rely on exactly that.
 *
 * Checked BETWEEN passes, never during one, so a half-finished calendar write
 * is not abandoned. The grace period stops a tight loop if a file's timestamp
 * moves without its contents changing — the project lives in OneDrive, which
 * touches files for reasons of its own.
 */
const RESTART_GRACE_MS = 5 * MIN;

function restartIfCodeChanged() {
  if (!codeHasChanged()) return false;
  if (Date.now() - startedAt < RESTART_GRACE_MS) return false;

  log('worker code has changed — exiting so the scheduled task starts a fresh one (within 10 minutes)');
  process.exit(0);
}

async function tick() {
  if (ticking) { log('tick skipped — the previous pass is still running'); return; }
  restartIfCodeChanged();
  ticking = true;
  tickStartedAt = Date.now();
  try {
    await runTick();
  } finally {
    ticking = false;
    tickStartedAt = null;
  }
}

async function runTick() {
  const did = [];

  /**
   * Things you asked for go first; background reading can wait.
   *
   * This ran last, after every source sync. That was fine while actions were
   * approvals already waited on, and wrong the moment a button existed that
   * you press and then watch for: a pass with Outlook mail and a
   * failing 12Twenty in it takes minutes — one hit the fifteen-minute wedge
   * guard and was killed before reaching this step at all — so "open the
   * sign-in window" would appear to do nothing for as long as the queue in
   * front of it took.
   *
   * Nothing here depends on a fresh sync. An action was queued against state
   * you were already looking at.
   */
  if (due('actions', ACTIONS_EVERY)) {
    await guarded('actions', () => runApprovedActions(sql, env, did), did);
  }

  // Asked once per pass, not once per job: three round trips to answer the
  // same question would be three chances for the answer to change mid-pass.
  let cloudDown = null;

  for (const job of JOBS) {
    if (!due(job.name, job.every)) continue;
    if (job.whenCloudIsDown) {
      if (cloudDown === null) cloudDown = await cloudIsDown(sql);
      if (!cloudDown) continue;
    }
    log(`running ${job.name}${job.whenCloudIsDown ? ' (covering for the cloud)' : ''}`);
    const r = await guarded(job.name, () => job.run(sql, env, did), did);
    if (r && r.ok !== false) log(`${job.name}:`, JSON.stringify(r));
  }

  if (due('reconcile', RECONCILE_EVERY)) {
    await guarded('reconcile', () => reconcileCalendars(sql, did), did);
    await guarded('mirror', () => mirrorOutlookToGoogle(sql, env, did), did);
    // Anything you have registered for on 12Twenty belongs on the real
    // calendar too — registering there does nothing to Google or Outlook.
    await guarded('mirror-registered', () => mirrorRegisteredEvents(sql, env, did), did);
    await guarded('mirror-registered-outlook', () => mirrorRegisteredToOutlook(sql, env, did), did);
  }

  if (did.length) {
    const next = new Date(Date.now() + 3 * MIN).toISOString();
    try { await recordRun(sql, did, next); } catch (e) { log('could not record run:', e.message); }
    for (const line of did) log('  ·', line);
  }
}

/**
 * Die rather than linger.
 *
 * Once this process had been up for four days and had not written
 * a heartbeat in four and a half hours: alive, holding the scheduled task's
 * single-instance slot, and doing nothing. The task fires every ten minutes
 * to restart a dead worker and backed off every time, correctly, because
 * something WAS running.
 *
 * The cause was this function swallowing its own error. A stale database
 * connection made every beat fail silently, so the worker looked healthy to
 * Windows and dead on the console, and the self-healing that was supposed to cover
 * exactly this could not see a difference.
 *
 * So: three consecutive failures — three minutes — and it exits. Exiting is
 * what makes the restart possible; staying up is what prevented it. One
 * failure is a blip and is logged, not acted on.
 */
const BEAT_FAILURES_BEFORE_EXIT = 3;
let beatFailures = 0;

async function beat() {
  try {
    await heartbeat(sql, 'loop');
    if (beatFailures) log(`heartbeat recovered after ${beatFailures} failure(s)`);
    beatFailures = 0;
  } catch (err) {
    beatFailures++;
    log(`heartbeat FAILED (${beatFailures}/${BEAT_FAILURES_BEFORE_EXIT}):`, err.message);
    if (beatFailures >= BEAT_FAILURES_BEFORE_EXIT) {
      log('cannot reach the database — exiting so the scheduled task can start a fresh worker');
      process.exit(1);
    }
  }
}

/**
 * A pass that never returns is the other way to be alive and useless.
 *
 * `ticking` exists so two passes cannot overlap, which means a single pass
 * wedged inside a browser call blocks every pass after it — permanently, and
 * without a word. Playwright calls carry their own timeouts, but a hang
 * outside one would sit there for ever.
 *
 * Fifteen minutes is longer than the slowest honest pass by a wide margin:
 * Outlook, 12Twenty and the mailbox together run well under two.
 */
const TICK_WEDGED_AFTER = 15 * MIN;
let tickStartedAt = null;

/**
 * Approved sign-in windows (12Twenty, Google), picked up within seconds.
 *
 * Called from its own fifteen-second timer in main(). Re-entrancy guarded so a
 * slow window launch cannot stack, and every failure is caught here: an error
 * escaping a setInterval callback would take the whole worker down.
 */
let signingIn = false;

async function signInTick() {
  if (signingIn) return;
  signingIn = true;
  const did = [];
  try {
    await runSignInActions(sql, env, did);
    if (did.length) {
      try { await recordRun(sql, did); } catch (e) { log('could not record run:', e.message); }
      for (const line of did) log('  ·', line);
    }
  } catch (e) {
    log('sign-in check failed:', e.message);
  } finally {
    signingIn = false;
  }
}

function checkForWedge() {
  if (!ticking || tickStartedAt === null) return;
  const stuck = Date.now() - tickStartedAt;
  if (stuck > TICK_WEDGED_AFTER) {
    log(`a pass has been running for ${Math.round(stuck / MIN)} minutes — exiting so it can be restarted`);
    process.exit(1);
  }
}

async function main() {
  log('worker loop starting');
  log('laptop half — gcal 2m, outlook 5m, outlook-mail 20m, 12twenty 3h, tracker 1h, reconcile 6m, actions 1m');
  log('cloud half (GitHub Actions) — canvas, gmail, gcal every 15m; jobs twice a day');
  log('canvas, gmail and jobs run here only while the cloud half is not reporting');

  await beat();

  /**
   * Timers BEFORE the first pass, not after.
   *
   * They used to be created once `await tick()` returned, which on a cold
   * start means after gcal, Outlook, 12Twenty and a twenty-nine-folder mailbox
   * read — minutes during which no heartbeat fired, no wedge check ran, and
   * the sign-in loop did not yet exist. A sign-in queued right after a restart
   * sat untouched because the thing meant to pick it up had not been started.
   *
   * Nothing is lost by starting them first: tick() has its own re-entrancy
   * guard, so the interval cannot double-run the pass below.
   */
  const beatTimer = setInterval(() => { void beat(); checkForWedge(); }, HEARTBEAT_EVERY);
  const tickTimer = setInterval(() => {
    if (!stopping) tick().catch((e) => log('tick threw:', e.message));
  }, 30_000);

  /**
   * Sign-in windows on their own fifteen seconds.
   *
   * A pass holds the next one off while it runs, and outlook-mail reads
   * twenty-nine folders — a sign-in queued at 8:31 was still waiting at 8:36
   * with the worker inside the mailbox the whole time. Five minutes is not a
   * button. This runs beside the pass rather than inside it.
   */
  const signInTimer = setInterval(() => {
    if (!stopping) void signInTick();
  }, 15_000);

  await tick();

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — stopping`);
    clearInterval(beatTimer);
    clearInterval(tickTimer);
    clearInterval(signInTimer);
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log('fatal:', err.message);
  process.exit(1);
});
