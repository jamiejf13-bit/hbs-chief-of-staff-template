// Calendar reconciliation (spec §1a).
//
// Google is the master. HBS blocks every route to writing Outlook — Microsoft's
// own Graph Explorer is refused for this account — so the console writes to
// Google and tells you what Outlook still needs. Nothing is ever deleted on one
// side because the other lacks it: an absence is still ambiguous, and the cost
// of guessing wrong is a real appointment gone.
//
// MATCHING. Time is the strong signal, not the title. The same commitment is
// routinely named differently in each calendar:
//
//   Outlook "MKT X"   vs  Google "MKT — Marketing"
//   Outlook "Dentist" vs  Google "Checkup — Dr. Example (Example Dental)"
//
// Title similarity alone flagged thirteen identical events as divergent. So
// events are bucketed by start time to the nearest 15 minutes, and titles are
// used only to pair them up when a bucket holds several from each source.

const BUCKET_MIN = 15;

export function bucketOf(startIso) {
  const t = new Date(startIso);
  const m = t.getMinutes();
  t.setMinutes(Math.round(m / BUCKET_MIN) * BUCKET_MIN, 0, 0);
  return t.toISOString().slice(0, 16);
}

/** Normalised tokens, for pairing within a bucket and judging title drift. */
function tokens(title) {
  return new Set(
    String(title).toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'class', 'session', 'group']);

function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Greedy pairing inside one time bucket, best title match first. */
function pair(outlook, google) {
  const pairs = [];
  const usedG = new Set();
  const scored = [];
  for (const o of outlook) {
    for (const g of google) scored.push({ o, g, s: similarity(o.title, g.title) });
  }
  scored.sort((x, y) => y.s - x.s);

  const usedO = new Set();
  for (const { o, g, s } of scored) {
    if (usedO.has(o.id) || usedG.has(g.id)) continue;
    usedO.add(o.id); usedG.add(g.id);
    pairs.push({ outlook: o, google: g, similarity: s });
  }
  return {
    pairs,
    outlookOnly: outlook.filter((o) => !usedO.has(o.id)),
    googleOnly: google.filter((g) => !usedG.has(g.id)),
  };
}

/** Titles this different are worth a glance, even when the time matches. */
const DRIFT_THRESHOLD = 0.34;

export async function reconcileCalendars(sql, did, { horizonDays = 21 } = {}) {
  // Only reconcile from sources that actually synced. A failed Outlook read
  // must never make events look deleted (spec §1a).
  const health = await sql`select name, status from sources where name in ('outlook','gcal')`;
  const outlookOk = health.find((h) => h.name === 'outlook')?.status === 'ok';
  if (!outlookOk) {
    did.push('Reconcile skipped — Outlook did not sync, so divergence cannot be judged');
    return { skipped: true };
  }

  const until = new Date(Date.now() + horizonDays * 86_400_000).toISOString();
  /**
   * Parked rows are left out.
   *
   * When a change made here reaches Google but not Outlook, the stale Outlook
   * twin is parked behind its Google row (`duplicate_of`) with a note saying
   * what to change by hand. Including it here would undo that: the pair no
   * longer shares a 15-minute bucket, so the Google row would read as
   * Google-only and reconciliation would offer to ADD it to Outlook — when
   * Outlook already has it, at the wrong time. One commitment, two entries,
   * and a confirmation asking for the wrong thing.
   */
  const rows = await sql`
    select id, title, start_at, end_at, location, source, seen_in, all_day
      from events
     where deleted_at is null and duplicate_of is null
       and outlook_needs is null
       and start_at >= now() and start_at <= ${until}`;

  const buckets = new Map();
  for (const r of rows) {
    const b = bucketOf(r.start_at);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }

  let matched = 0, drifted = 0, outlookOnly = 0, googleOnly = 0;
  const conflicts = [];
  const orphans = [];

  for (const [bucket, group] of buckets) {
    const o = group.filter((e) => e.source === 'outlook');
    const g = group.filter((e) => e.source === 'gcal');
    if (!o.length && !g.length) continue;

    const { pairs, outlookOnly: oOnly, googleOnly: gOnly } = pair(o, g);

    for (const p of pairs) {
      // The pair's own key, not the bucket's. Two genuinely different events
      // can share a 15-minute bucket — a 9:30 class and a 9:30 coffee — and
      // keying on the bucket alone gave them the same match_key, which makes
      // them indistinguishable to anything downstream that collapses
      // duplicates. The Outlook id is stable across runs, so the key is too.
      const key = `${bucket}|paired|${p.outlook.id}`;
      await sql`update events set match_key = ${key}, seen_in = ${['outlook', 'gcal']}
                 where id in (${p.outlook.id}, ${p.google.id})`;
      matched++;
      if (p.similarity < DRIFT_THRESHOLD) {
        drifted++;
        conflicts.push({ bucket, outlook: p.outlook, google: p.google });
      }
    }

    for (const e of oOnly) {
      await sql`update events set match_key = ${`${bucket}|o`}, seen_in = ${['outlook']} where id = ${e.id}`;
      outlookOnly++;
    }
    for (const e of gOnly) {
      await sql`update events set match_key = ${`${bucket}|g`}, seen_in = ${['gcal']} where id = ${e.id}`;
      googleOnly++;
      orphans.push(e);
    }
  }

  // Google-only is the ambiguous case and the only one that asks you.
  //
  // Capped hard. The spec targets 1–5 pending actions per day, and the first
  // run after connecting Google produced 31 — most of them old personal
  // entries that were never going to be in Outlook. A wall of confirmations
  // is the failure mode that got the previous system deleted, so ask about
  // the soonest few and let the rest wait for a later run.
  const ASK_LIMIT = 5;
  /**
   * Two kinds of Google-only event are not divergence and must not be asked
   * about, or the queue fills with things that will never be actioned.
   *
   * All-day entries — birthdays, retreats, weddings — tend to live in
   * Google as personal entries. Outlook has no use for them and never will,
   * so "shall I copy this to Outlook?" has no right answer. Eight birthdays
   * were sitting in the queue on that question.
   *
   * Flights are held back deliberately. Itineraries imported into Google from
   * booking emails are often duplicated or stale (a rebooked trip leaves the
   * old flights behind), and mirroring a wrong itinerary into the other
   * calendar would double the mess rather than resolve it. Drop the isFlight
   * filter below if your Google flights are clean and you want them asked about.
   */
  const isFlight = (t) => /flight/i.test(t ?? '');

  const soonestFirst = orphans
    .filter((e) => !e.all_day && !isFlight(e.title))
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at))
    .slice(0, ASK_LIMIT);



  let asked = 0;
  for (const e of soonestFirst) {
    const [existing] = await sql`
      select id from actions
       where type = 'mirror_to_outlook' and status = 'pending'
         and payload->>'event_id' = ${e.id} limit 1`;
    if (existing) continue;

    const when = new Date(e.start_at).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    await sql`
      insert into actions (type, summary, detail, payload, confidence, expires_at)
      values ('mirror_to_outlook',
              ${`In Google but not Outlook: ${e.title}`},
              ${`${when}${e.location ? ` · ${e.location}` : ''}. Either you added it in Google and it never reached Outlook, or it was cancelled there.`},
              ${JSON.stringify({ event_id: e.id, title: e.title, start_at: e.start_at, location: e.location })}::jsonb,
              0.5, ${e.start_at})`;
    asked++;
  }

  if (matched) did.push(`Calendars: ${matched} event${matched === 1 ? '' : 's'} matched across Outlook and Google`);
  if (outlookOnly) did.push(`Calendars: ${outlookOnly} in Outlook only — mirroring into Google`);
  if (asked) {
    const held = googleOnly - asked;
    did.push(
      `Calendars: ${asked} in Google only — queued for you to confirm` +
      (held > 0 ? ` (${held} more held back to keep the queue short)` : ''),
    );
  }
  if (drifted) did.push(`Calendars: ${drifted} matched pair${drifted === 1 ? '' : 's'} with very different titles`);

  return { matched, drifted, outlookOnly, googleOnly, asked, conflicts: conflicts.length };
}
