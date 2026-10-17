// Participation, read from the Class Log tab of the owner's tracker workbook.
//
// Read-only, always. The tracker is maintained by hand; this never writes to
// it, and nothing here invents a session. A class attended but not logged
// leaves the count short — which is the correct answer, because a fabricated
// row is worse than a gap.
//
// Point PARTICIPATION_XLSX (in .env.local) or participation.path in
// lib/profile.json at the ONE canonical copy. Stale copies of a tracker tend
// to multiply across a laptop and Drive, and reading the wrong one is an
// expensive, silent mistake. Leave both empty to turn this source off.

import { existsSync } from 'node:fs';
import { readSheet, excelDate } from './xlsx.mjs';
import { markSource, log } from './lib.mjs';
import { PROFILE, COURSE_CODES } from './profile.mjs';

/** The configured tracker path, or '' when participation tracking is off. */
export const TRACKER = process.env.PARTICIPATION_XLSX || PROFILE.participation?.path || '';

/** The tab to read. */
const SHEET = PROFILE.participation?.sheet || 'Class Log';

const COURSES = COURSE_CODES;

/** Column positions in the Class Log: Date, Course, Topic, _, Spoke, Type, Impact. */
const COL = { date: 0, course: 1, topic: 2, spoke: 4, type: 5, impact: 6 };

/**
 * One row of the Class Log, or null when it is not a session.
 *
 * "Spoke" is Y or N. Anything else — a blank, a "[CONFIRM]" left as a
 * reminder — counts as not spoken rather than as spoken, because overstating
 * participation is the failure that matters here.
 */
function parseRow(row) {
  const course = String(row[COL.course] ?? '').trim().toUpperCase();
  if (!COURSES.includes(course)) return null;

  const raw = row[COL.date];
  const date = raw == null ? null
    : (Number.isFinite(Number(raw)) ? excelDate(raw) : new Date(String(raw)));
  if (!date || Number.isNaN(date.getTime())) return null;

  const spoke = String(row[COL.spoke] ?? '').trim().toUpperCase() === 'Y';
  return {
    course,
    date,
    spoke,
    type: String(row[COL.type] ?? '').trim() || null,
  };
}

/**
 * How many sessions a course has already held.
 *
 * The Class Log only holds what was written down, so counting it reported
 * "spoken in 1 of 1" for a course that had met four times with one session
 * logged. Canvas numbers its assignments — "MKT | Class 5: Predicting the
 * Diffusion of New Products" — so the lowest class still ahead, minus
 * one, is how many have gone.
 *
 * Returns null when Canvas has no numbered assignment for the course, in which
 * case the log is all there is and the count says so.
 */
async function schedule(sql, course) {
  const rows = await sql`
    select (regexp_match(title, 'Class ([0-9]+)'))[1]::int as n, min(due_at) as due
      from tasks
     where source = 'canvas' and deleted_at is null
       and course = ${course} and title ~ 'Class [0-9]+'
     group by 1 order by 1`;

  const known = rows
    .filter((r) => r.n && r.due)
    .map((r) => ({ n: Number(r.n), at: Date.parse(r.due) }));
  if (!known.length) return null;

  const held = known[0].n > 1 ? known[0].n - 1 : 0;
  if (!held) return { held: 0, dateOf: () => null, perClass: null };

  /**
   * Roughly how far apart the sessions are.
   *
   * Classes come in pairs on consecutive days and then a gap, so this is an
   * average rather than a rule — good enough to say whether a session fell
   * before or after a date a week ago, which is all it is used for.
   */
  const gaps = [];
  for (let i = 1; i < known.length; i++) {
    const dn = known[i].n - known[i - 1].n;
    if (dn > 0) gaps.push((known[i].at - known[i - 1].at) / dn);
  }
  const perClass = gaps.length
    ? gaps.reduce((a, b) => a + b, 0) / gaps.length
    : 3.5 * 86_400_000;

  // Walk backwards from the first class we have a real date for.
  const anchor = known[0];
  const dateOf = (n) => new Date(anchor.at - (anchor.n - n) * perClass);

  return { held, dateOf, perClass };
}

export async function syncParticipation(sql, env, did, { path } = {}) {
  path = path || env?.PARTICIPATION_XLSX || TRACKER;
  if (!path) {
    // Optional source: not configured is not a failure.
    log('participation: not configured');
    return { ok: true, skipped: 'not configured' };
  }
  if (!existsSync(path)) {
    const why = `Participation tracker not found at ${path}`;
    await markSource(sql, 'tracker', false, why).catch(() => {});
    did.push(`Participation FAILED — ${why}`);
    return { ok: false, reason: why };
  }

  let rows;
  try {
    rows = readSheet(path, SHEET);
  } catch (err) {
    const why = `Could not read the ${SHEET} sheet: ${err.message}`;
    await markSource(sql, 'tracker', false, why).catch(() => {});
    did.push(`Participation FAILED — ${why}`);
    return { ok: false, reason: why };
  }

  // Row 1 is the header.
  const sessions = rows.slice(1).map(parseRow).filter(Boolean)
    .sort((a, b) => a.date - b.date);

  let updated = 0;
  for (const course of COURSES) {
    const mine = sessions.filter((s) => s.course === course);
    if (!mine.length) continue;

    const spoken = mine.filter((s) => s.spoke);
    const last = spoken.at(-1) ?? null;

    // The term's count where Canvas knows it, the log's where it does not.
    const sched = await schedule(sql, course);
    const total = Math.max(sched?.held ?? 0, mine.length);

    /**
     * Sessions since last speaking — sessions that happened AFTER that date.
     *
     * The previous version computed `held − logged`, which assumes every
     * session never written down came after the last one spoken in. It does
     * not: unlogged sessions are spread across the term. One course came out
     * as four right after speaking in the most recent class, which is the
     * opposite of useful.
     *
     * Now each session's date is estimated from Canvas's class numbering and
     * counted only if it falls after the last time spoken and before today. Where
     * Canvas has no numbering the log is all there is, and the answer is what
     * the log says.
     */
    /**
     * When the log is current, believe it.
     *
     * Estimated class dates are averaged across a term whose sessions come in
     * pairs then gaps, so they drift by a day or two — enough to invent a
     * session between the last entry and today that never happened. One course
     * came out as one right after speaking in the most recent class.
     *
     * So: if the newest entry for a course is more recent than one class gap,
     * the log has caught up and the log is the answer. The estimate is only
     * used when the log has visibly fallen behind.
     */
    const now = Date.now();
    const newestLogged = mine.at(-1)?.date ?? null;
    const gap = sched?.perClass ?? 4 * 86_400_000;
    const logIsCurrent = newestLogged ? now - newestLogged.getTime() < gap : false;
    let since;
    if (!last) {
      since = total;
    } else if (logIsCurrent) {
      since = mine.filter((s) => s.date > last.date).length;
    } else if (sched?.held) {
      let after = 0;
      for (let n = 1; n <= sched.held; n++) {
        const at = sched.dateOf(n);
        if (at && at.getTime() > last.date.getTime() && at.getTime() <= now) after++;
      }
      // Never fewer than the log itself can prove.
      since = Math.max(after, mine.filter((s) => s.date > last.date).length);
    } else {
      since = mine.filter((s) => s.date > last.date).length;
    }

    await sql`
      insert into participation (course, sessions_since_spoke, last_spoke_at,
                                 spoke_count, total_sessions, logged_sessions, last_type)
      values (${course}, ${since}, ${last ? last.date.toISOString() : null},
              ${spoken.length}, ${total}, ${mine.length}, ${last?.type ?? null})
      on conflict (course) do update
        set sessions_since_spoke = excluded.sessions_since_spoke,
            last_spoke_at        = excluded.last_spoke_at,
            spoke_count          = excluded.spoke_count,
            total_sessions       = excluded.total_sessions,
            logged_sessions      = excluded.logged_sessions,
            last_type            = excluded.last_type`;
    updated++;
  }

  await markSource(sql, 'tracker', true).catch(() => {});

  /**
   * Only worth a line when it is worth acting on.
   *
   * The point is a warning when going quiet in a course, not congratulations
   * for having spoken. Two sessions is the point at which it
   * becomes a real risk of a cold call landing badly.
   */
  const quiet = [];
  for (const r of await sql`select course, sessions_since_spoke from participation
                             where total_sessions > 0 and sessions_since_spoke >= 2
                             order by sessions_since_spoke desc`) {
    quiet.push(`${r.course} (${r.sessions_since_spoke})`);
  }
  if (quiet.length) did.push(`Quiet for two or more sessions: ${quiet.join(', ')}`);

  return { ok: true, sessions: sessions.length, courses: updated };
}
