import { db, hasDb } from './db';
import { seedState } from './seed';
import { COURSE_CODES } from './profile';
import type {
  ConsoleState, Task, CalEvent, AgentAction, SourceHealth, Weights,
  Participation, AgentRun, EmailItem, JobPosting, Person,
} from './types';

const WORKER_OFFLINE_AFTER_MS = 60 * 60 * 1000; // spec §8: one hour

/**
 * The cloud half gets six, not one.
 *
 * It is a backstop for when the laptop is shut, and GitHub honours maybe a
 * tenth of a twenty-minute schedule. Holding it to the laptop's standard meant
 * a permanent alarm about a system that was working.
 */
const CLOUD_OFFLINE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * How much calendar to fetch either side of now.
 *
 * This was one day back, which was fine while the calendar only showed today.
 * It is not fine in the week and month views: on a Thursday, Monday through
 * Wednesday had no events to draw and rendered as empty columns — "my calendar
 * is now not showing for completed days". The days were
 * there; the data stopped at yesterday.
 *
 * Five weeks back covers a month grid's leading days and any week scrolled
 * to; six weeks forward covers its trailing ones. Measured cost: 156 events
 * becomes 282, which is nothing to send and a great deal less confusing.
 */
const PAST_DAYS = 35;
const FUTURE_DAYS = 45;

/**
 * Everything the UI renders, in one read.
 *
 * Falls back to seed data when DATABASE_URL is unset so the Today view can be
 * judged before Postgres exists. `seeded: true` travels with the payload and
 * the UI says so on screen — invented data must never look like real data.
 */
export async function getState(): Promise<ConsoleState> {
  if (!hasDb()) return seedState();

  const sql = db();
  if (!sql) return seedState();

  const horizonPast = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString();
  const horizonFuture = new Date(Date.now() + FUTURE_DAYS * 86_400_000).toISOString();

  const [
    taskRows, eventRows, actionRows, sourceRows, weightRows, beatRows,
    partRows, runRows, prefRows, emailRows, jobRows, peopleRows] = await Promise.all([
    sql`select * from tasks
         where deleted_at is null
         order by due_at nulls last, created_at`,
    sql`select * from events
         where deleted_at is null
           -- A pair merged by hand in the chat box. Hidden, not deleted.
           and duplicate_of is null
           and start_at between ${horizonPast} and ${horizonFuture}
         order by start_at`,
    sql`select * from actions
         where status in ('pending','approved','executing','failed')
         order by created_at desc`,
    sql`select * from sources order by name`,
    sql`select * from weights where id = true`,
    sql`select beat_at, started_at, code_stale, cloud_beat_at from worker_heartbeat where id = true`,
    sql`select course, sessions_since_spoke, last_spoke_at, goal_every,
               spoke_count, total_sessions, logged_sessions, last_type
          from participation
         order by course`,
    sql`select id, finished_at, next_run_at, did
          from agent_runs order by finished_at desc limit 1`,
    sql`select get_ahead_dismissed_for from prefs where id = true`,
    // Open items only, best first. Handled ones stay in the table as history
    // but have no business on the page.
    sql`select id, source, folder, kind, subject, from_name, from_email, snippet, url,
               reasons, score, received_at, handled, draft, tldr
          from email_items
         where not handled
         order by score desc, received_at desc
         limit 40`,
    /**
     * Open roles first, closed ones after — never hidden.
     *
     * `expired_at nulls first` is the whole of "expired goes to the bottom".
     * A role that has closed is still worth seeing: the owner may have applied
     * to it, and silently dropping it would leave them wondering whether it was
     * ever there. Applied ones leave the list entirely, because they are no
     * longer something to act on.
     */
    sql`select id, source, company, title, location, url, posted_at,
               reasons, score, first_seen, applied, expired_at
          from job_postings
         where not dismissed and not applied
         order by expired_at nulls first, score desc, first_seen desc
         limit 25`,
    sql`select id, source, name, employer, title, location, program,
               grad_year, score, reasons, url, contacted_at
          from people
         where not dismissed
         order by score desc, updated_at desc
         limit 20`,
  ]);

  const beat = (beatRows as unknown as
    { beat_at: string; started_at: string | null; code_stale: boolean;
      cloud_beat_at: string | null }[])[0];
  const lastBeat = beat?.beat_at ?? null;
  const w = (weightRows as Weights[])[0];

  const pref = (prefRows as unknown as { get_ahead_dismissed_for: string | Date | null }[])[0];
  const dismissed = pref?.get_ahead_dismissed_for ?? null;

  return {
    now: new Date().toISOString(),
    prefs: {
      // Postgres `date` arrives as a Date from the driver; the UI compares it
      // against a YYYY-MM-DD string, so normalise here rather than in render.
      get_ahead_dismissed_for: dismissed
        ? (typeof dismissed === 'string' ? dismissed.slice(0, 10) : dismissed.toISOString().slice(0, 10))
        : null,
    },
    tasks: taskRows as unknown as Task[],
    events: oneRowPerEvent(eventRows as unknown as CalEvent[]),
    actions: actionRows as unknown as AgentAction[],
    sources: sourceRows as unknown as SourceHealth[],
    participation: partRows as unknown as Participation[],
    emails: emailRows as unknown as EmailItem[],
    jobs: jobRows as unknown as JobPosting[],
    people: peopleRows as unknown as Person[],
    last_run: ((runRows as unknown as AgentRun[])[0] ?? null),
    weights: w,
    worker_last_beat: lastBeat,
    worker_offline:
      lastBeat === null || Date.now() - Date.parse(lastBeat) > WORKER_OFFLINE_AFTER_MS,
    worker_started_at: beat?.started_at ?? null,
    worker_code_stale: Boolean(beat?.code_stale),
    cloud_last_beat: beat?.cloud_beat_at ?? null,
    /**
     * Late is not stopped, and GitHub is late almost always.
     *
     * The threshold was one hour, on the assumption that a twenty-minute
     * schedule missing three runs meant something was wrong. Measured over
     * twenty-eight hours: seven runs happened where sixty were scheduled, every
     * one of them green. GitHub silently drops scheduled runs on free runners
     * and says so in its own documentation. An hour therefore fired almost
     * continuously, for a thing that was working.
     *
     * That is worse than useless. The laptop covered for the cloud 191 times
     * in the same log without comment, which is the arrangement working as
     * designed — so an alarm in that state teaches the owner to ignore alarms, and
     * the next one will be about something real.
     *
     * Six hours is past anything GitHub's queueing explains. The banner is also
     * suppressed while the laptop is running, because then nothing is stale and
     * there is nothing to act on.
     */
    cloud_offline:
      !beat?.cloud_beat_at
      || Date.now() - Date.parse(beat.cloud_beat_at) > CLOUD_OFFLINE_AFTER_MS,
    seeded: false,
  };
}

/**
 * One calendar, not two.
 *
 * A reconciled event exists as two rows — the Outlook one and the Google one —
 * sharing a `match_key`. Both are kept in the database on purpose: that is how
 * we can tell which side changed. But the owner wants to read the day once, so
 * the UI gets a single row per real event.
 *
 * **Outlook wins.** The owner maintains Outlook and mirrors into Google, so when the
 * two disagree the Outlook row is the more likely to be current. Where they
 * disagree in a way that matters, reconciliation has already raised a
 * confirmation card — collapsing them here does not hide a conflict, it just
 * stops the same meeting appearing twice.
 *
 * Unmatched rows have no `match_key` and pass through untouched.
 */
function oneRowPerEvent(rows: CalEvent[]): CalEvent[] {
  const byKey = new Map<string, CalEvent>();
  const out: CalEvent[] = [];

  for (const ev of rows) {
    const key = (ev as CalEvent & { match_key?: string | null }).match_key;
    if (!key) { out.push(ev); continue; }

    const held = byKey.get(key);
    if (!held) {
      byKey.set(key, ev);
      out.push(ev);
      continue;
    }
    // Already have one for this key. Swap it out only if this row is the
    // Outlook side and the one we kept is not.
    if (ev.source === 'outlook' && held.source !== 'outlook') {
      byKey.set(key, ev);
      out[out.indexOf(held)] = ev;
    }
  }

  return collapseRepeats(out).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
}

/**
 * The same commitment entered twice, in one calendar.
 *
 * `match_key` only pairs Outlook against Google. It cannot help when a single
 * calendar holds two copies of one appointment — which happens in practice:
 * "CPD Student Advisor — Pat Example" and "CPD Student Advisor -
 * Pat Example - Appointment", same time, both in Outlook and both in
 * Google. Four rows, one meeting.
 *
 * So titles are normalised (case, punctuation, and the trailing noise
 * calendar invitations accumulate) and anything landing in the same
 * 15-minute slot with the same normalised title is one event. The longest
 * title is kept, on the grounds that it carries the most information.
 *
 * This is conservative on purpose: two genuinely different events at the same
 * time keep different titles, so they survive.
 */
function collapseRepeats(rows: CalEvent[]): CalEvent[] {
  const best = new Map<string, CalEvent>();
  const order: string[] = [];

  for (const ev of rows) {
    const key = `${bucket(ev.start_at)}|${normalise(ev.title)}`;
    const held = best.get(key);

    if (!held) {
      best.set(key, ev);
      order.push(key);
      continue;
    }
    // Prefer the fuller title, and an Outlook row over a Google one.
    const better =
      (ev.source === 'outlook' && held.source !== 'outlook') ||
      (ev.source === held.source && ev.title.length > held.title.length);
    if (better) best.set(key, ev);
  }

  return order.map((k) => best.get(k)!);
}

/**
 * A title reduced to the thing it is actually about.
 *
 * Calendar invitations accumulate boilerplate that differs between the copy
 * 12Twenty sends, the copy Outlook stores and the copy Google mirrors. One
 * speaker session appeared five times as "Conversation with Pat Example
 * (Example Co) — Sign Up Required", the same with a hyphen, and "Pat
 * Example from Example Co". Stripping the connective words leaves the
 * names and the company, which is what distinguishes one event from another.
 */
/** A title that begins with one of the configured course codes (lib/profile.json). */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COURSE_CODE = new RegExp(
  `^\\s*(${COURSE_CODES.map(escapeRe).join('|') || '(?!)'})\\b`, 'i');

function normalise(title: string): string {
  /**
   * A class is its course code and nothing else.
   *
   * Outlook calls Tuesday's marketing class "MKT X" (code plus section); Google calls it
   * "MKT — Marketing". No amount of stripping connective words makes those
   * equal, and two different MKT classes cannot start in the same 15 minutes.
   * So a title that begins with a course code reduces to that code, and the
   * page stops showing every class twice even before reconciliation has run.
   */
  const course = title.match(COURSE_CODE);
  if (course) return course[1].toLowerCase();

  return title
    .toLowerCase()
    .replace(/[‐-―]/g, '-')                     // en/em dashes
    .replace(/\bsign ?-? ?up required\b/g, '')
    .replace(/\b(appointment|meeting|invitation|invite|conversation|session|call|with|from|w\/)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bucket(iso: string): number {
  return Math.round(Date.parse(iso) / (15 * 60_000));
}
