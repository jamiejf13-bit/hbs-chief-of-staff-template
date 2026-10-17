// HBS Outlook → events, through a real browser.
//
// Outlook has no API available to students (HBS runs its own Microsoft tenant and
// blocks third-party connectors), so the only way in is a signed-in browser.
// Run worker/outlook-login.mjs once; after that the saved profile means this
// runs headless and unattended.
//
// Events are read from the calendar's accessibility labels rather than from
// pixel positions. Outlook writes a complete description into each one:
//
//   MKT X, 9:30 AM to 10:50 AM, Tuesday, September 22, 2026,
//   Example Hall 101 (classroom), Busy, Categorized as Calendar Events
//
// That gives exact times, which reading a week grid never did.

import { chromium } from 'playwright';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, rmSync } from 'node:fs';
import { markSource } from './lib.mjs';
import { deleteMirror } from './gcal.mjs';
import { PROFILE as OWNER } from './profile.mjs';

/** Outside OneDrive — a synced Chromium profile cannot hold its lock file. */
export const PROFILE = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'hbs-chief-of-staff',
  'outlook-profile',
);

/**
 * The full week, not the work week.
 *
 * This was `view/workweek`, which draws Monday to Friday and nothing else — so
 * every Saturday and Sunday entry was invisible to this reader. Not dropped by
 * the parser, never on the page to begin with, which is why it failed silently
 * for weeks: the counts looked healthy because weekdays were complete.
 *
 * Measured before changing it: of the events in a six-week window, Outlook had
 * reported 177 weekday ones and exactly zero at the weekend, while twelve
 * weekend events existed.
 */
const CAL = 'https://outlook.cloud.microsoft/calendar/view/week';

/** Markers Outlook appends after the location. Everything before the first
 *  of these is the location, which may itself contain commas. */
const TRAILING = /^(Busy|Free|Tentative|Out of office|Working elsewhere|Recurring event|All day event|Categorized as .*|By .*)$/;

const MONTHS = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

export function clearStaleLocks() {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = join(PROFILE, f);
    if (existsSync(p)) { try { rmSync(p, { force: true, recursive: true }); } catch { /* ignore */ } }
  }
}

/**
 * Parse one aria-label into an event.
 * Returns null for labels that are not events (the "current time" marker).
 */
export function parseLabel(label) {
  const text = label.replace(/\s+/g, ' ').trim();

  // Same-day:  "MKT X, 9:30 AM to 10:50 AM, Tuesday, September 22, 2026, ..."
  const same = /^(.+?),\s*(\d{1,2}:\d{2}\s*[AP]M)\s+to\s+(\d{1,2}:\d{2}\s*[AP]M),\s*\w+day,\s*(\w+)\s+(\d{1,2}),\s*(\d{4})(?:,\s*(.*))?$/i.exec(text);

  // Spanning midnight, which Outlook labels quite differently:
  //   "Flight: XX 123 from BOS to LHR, 5:05 PM Thursday, September 24, 2026
  //    to 1:05 AM Friday, September 25, 2026, ..."
  // Overnight flights are exactly this shape, so dropping them would lose
  // travel that conflicts with the next day's classes.
  const span = same ? null
    : /^(.+?),\s*(\d{1,2}:\d{2}\s*[AP]M)\s+\w+day,\s*(\w+)\s+(\d{1,2}),\s*(\d{4})\s+to\s+(\d{1,2}:\d{2}\s*[AP]M)\s+\w+day,\s*(\w+)\s+(\d{1,2}),\s*(\d{4})(?:,\s*(.*))?$/i.exec(text);

  if (!same && !span) return null;

  let title, start, end, rest;

  if (same) {
    const [, t, startRaw, endRaw, monthName, day, year, tail = ''] = same;
    const month = MONTHS[monthName];
    if (month === undefined) return null;
    title = t;
    start = at(Number(year), month, Number(day), startRaw);
    end = at(Number(year), month, Number(day), endRaw);
    if (end && start && end < start) end = new Date(end.getTime() + 86_400_000);
    rest = tail;
  } else {
    const [, t, sRaw, sMon, sDay, sYear, eRaw, eMon, eDay, eYear, tail = ''] = span;
    if (MONTHS[sMon] === undefined || MONTHS[eMon] === undefined) return null;
    title = t;
    start = at(Number(sYear), MONTHS[sMon], Number(sDay), sRaw);
    end = at(Number(eYear), MONTHS[eMon], Number(eDay), eRaw);
    rest = tail;
  }

  if (!start) return null;

  // Location is whatever precedes the first trailing marker.
  const parts = rest.split(',').map((s) => s.trim()).filter(Boolean);
  let cut = parts.findIndex((p) => TRAILING.test(p));
  if (cut === -1) cut = parts.length;
  const location = parts.slice(0, cut).join(', ') || null;

  const organizer = (rest.match(/\bBy ([^,]+(?:,\s*[^,]+)?)/) ?? [])[1]?.trim() ?? null;

  return {
    title: title.trim(),
    start_at: start.toISOString(),
    end_at: end ? end.toISOString() : null,
    location,
    organizer,
  };
}

// Kept for the login probe, which reports what it could and could not read.
export const PARSER_NOTE = 'same-day and midnight-spanning aria-labels';

function at(year, month, day, hhmm) {
  const t = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(hhmm.trim());
  if (!t) return null;
  let h = Number(t[1]) % 12;
  if (t[3].toUpperCase() === 'P') h += 12;
  return new Date(year, month, day, h, Number(t[2]), 0, 0);
}

/** Stable id so re-reading the same week updates rather than duplicates. */
function sourceId(ev) {
  const slug = ev.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `outlook/${ev.start_at.slice(0, 16)}/${slug}`;
}

/** Words dropped before matching titles: the section letter ("MKT X") and filler. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOISE_RE = new RegExp(
  `\\b(${[String(OWNER.section ?? '').toLowerCase(), 'class', 'session']
    .filter(Boolean).map(escapeRe).join('|')})\\b`,
  'g',
);

/** Recognises the same commitment across calendars: title + 15-minute bucket. */
export function matchKey(title, startIso) {
  const norm = title.toLowerCase()
    .replace(NOISE_RE, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 28);
  const t = new Date(startIso);
  t.setMinutes(Math.round(t.getMinutes() / 15) * 15, 0, 0);
  return `${norm}|${t.toISOString().slice(0, 16)}`;
}

async function readWeek(page, offsetWeeks) {
  if (offsetWeeks > 0) {
    // "Go to next week" — the forward arrow in the calendar toolbar.
    const next = page.locator('button[aria-label^="Go to next"]').first();
    for (let i = 0; i < offsetWeeks; i++) {
      await next.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="button"][aria-label], [data-app-section] [aria-label]')) {
      const label = el.getAttribute('aria-label') ?? '';
      // Collect anything carrying a clock time and let parseLabel decide.
      //
      // This filter used to require "to" immediately after the time, which
      // matches same-day events only. A midnight-spanning event reads
      // "5:05 PM Thursday, September 24, 2026 to 1:05 AM Friday, ..." — the
      // date comes between — so every overnight flight was dropped here,
      // silently, even though the parser handled it correctly.
      if (/\d{1,2}:\d{2}\s*(AM|PM)/i.test(label)) out.push(label);
    }
    return [...new Set(out)];
  });
}

export async function syncOutlook(sql, env, did, { weeks = 2 } = {}) {
  clearStaleLocks();

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      viewport: { width: 1500, height: 1000 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    await markSource(sql, 'outlook', false, `browser failed to launch: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(CAL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);

    const labels = [];
    for (let w = 0; w < weeks; w++) {
      labels.push(...(await readWeek(page, w === 0 ? 0 : 1)));
    }

    if (labels.length === 0) {
      // Almost always an expired session: the page is a sign-in form.
      const url = page.url();
      const signedOut = /login\.microsoftonline|\/auth\//i.test(url);
      const reason = signedOut
        ? 'Signed out — run "node worker/outlook-login.mjs" to sign in again'
        : `No calendar entries readable at ${url.slice(0, 80)}`;
      await markSource(sql, 'outlook', false, reason);
      did.push(`Outlook FAILED — ${reason}`);
      return { ok: false, reason };
    }

    const events = [];
    const seenIds = new Set();
    for (const label of labels) {
      const ev = parseLabel(label);
      if (!ev) continue;
      const id = sourceId(ev);
      if (seenIds.has(id)) continue; // Outlook renders some chips twice
      seenIds.add(id);
      events.push({ ...ev, source_id: id, match_key: matchKey(ev.title, ev.start_at) });
    }

    let added = 0, updated = 0, realigned = 0;
    for (const ev of events) {
      const [existing] = await sql`
        select id from events where source = 'outlook' and source_id = ${ev.source_id} limit 1`;
      if (existing) {
        /**
         * `match_key` and `seen_in` are deliberately not written here.
         *
         * They belong to reconciliation, which pairs this row with its Google
         * twin. This sync runs every 15 minutes and reconciliation every 16,
         * so overwriting them meant the pairing was destroyed almost as soon
         * as it was made — and every class showed twice on the page for most
         * of each hour, once as "MKT X" and once as "MKT — Marketing".
         *
         * Only the facts Outlook owns are refreshed.
         */
        await sql`
          update events
             set title = ${ev.title}, start_at = ${ev.start_at}, end_at = ${ev.end_at},
                 location = ${ev.location}, deleted_at = null
           where id = ${existing.id}`;
        updated++;

        /**
         * Outlook was caught up by hand — stop asking.
         *
         * A console change lands in Google and leaves Outlook behind, so the
         * stale Outlook row is parked behind its Google twin with a note
         * saying what to change. The only way to know that has happened is to
         * watch this sync: when Outlook comes back reporting the same time
         * the Google twin already has, the two agree again.
         *
         * Cleared here rather than by asking you to tick something off. A
         * flag that has to be dismissed by hand becomes a flag that is always
         * up, and then it says nothing at all.
         */
        const [twin] = await sql`
          select e.id as outlook_id, g.id as google_id
            from events e
            join events g
              on g.id = e.duplicate_of
              -- Rows flagged before parking existed have no duplicate_of, so
              -- they are found through the pairing reconciliation already made.
              -- Without this they stay red for ever: the flag is only ever
              -- cleared by agreement, and nothing was looking for it.
              or (e.duplicate_of is null and g.source = 'gcal'
                  and g.match_key is not null and g.match_key = e.match_key
                  and g.deleted_at is null and g.id <> e.id)
           where e.id = ${existing.id}
             and (e.duplicate_of is not null or e.sync_state = 'failed')
             and abs(extract(epoch from (g.start_at - ${ev.start_at}::timestamptz))) < 60
           limit 1`;

        if (twin) {
          await sql`
            update events set duplicate_of = null, sync_state = 'synced', sync_error = null
             where id = ${twin.outlook_id}`;
          await sql`update events set outlook_needs = null where id = ${twin.google_id}`;
          realigned++;
        }
      } else {
        await sql`
          insert into events (title, start_at, end_at, location, source, source_id, match_key, seen_in)
          values (${ev.title}, ${ev.start_at}, ${ev.end_at}, ${ev.location},
                  'outlook', ${ev.source_id}, ${ev.match_key}, ${['outlook']})`;
        added++;
      }
    }

    /**
     * Rows Outlook no longer shows — a moved or renamed event's old self.
     *
     * `sourceId()` is built from the start time and the title, because the
     * Outlook web calendar exposes no stable item id on a chip. That is
     * workable ONLY if vanished rows are retired. Without this step, moving
     * an event from 1:30 to 4:30 did not edit it: it created a
     * second one and left the first in place, and because the mirror had
     * already run, the stale 1:30 copy sat in the real Google calendar with
     * nothing left to correct it. Renaming did the same — "Coffee Chat" and
     * "Cup icon, Coffee Chat" are one commitment, stored twice.
     *
     * Scoped to the span actually read rather than an assumed two-week
     * window, so a short or partial read can never retire an event that
     * Outlook simply did not show us. Over-retiring here would delete real
     * entries from your calendar, so the conservative bound is the right one.
     */
    let retired = [];
    if (events.length) {
      const starts = events.map((e) => Date.parse(e.start_at)).sort((a, b) => a - b);
      const from = new Date(starts[0]).toISOString();
      const to = new Date(starts[starts.length - 1]).toISOString();

      retired = await sql`
        update events set deleted_at = now()
         where source = 'outlook' and deleted_at is null
           and start_at >= ${from} and start_at <= ${to}
           and not (source_id = any(${[...seenIds]}))
         returning id, title, start_at, mirror_gcal_id`;
    }

    /**
     * A retired row's mirror has to leave Google too.
     *
     * The console put it there; if it stays, you are looking at an event that
     * no longer exists in Outlook and has no way to tell. This only ever
     * removes ids the console recorded itself.
     */
    let unmirrored = 0;
    for (const r of retired) {
      if (!r.mirror_gcal_id) continue;
      try {
        await deleteMirror(env, r.mirror_gcal_id);
        await sql`update events set mirror_gcal_id = null where id = ${r.id}`;
        unmirrored++;
      } catch (err) {
        did.push(`Could not remove the stale Google copy of "${r.title.slice(0, 40)}" — ${String(err.message).slice(0, 80)}`);
      }
    }

    await markSource(sql, 'outlook', true);
    if (added) did.push(`Outlook: ${added} new event${added === 1 ? '' : 's'}`);
    if (updated) did.push(`Outlook: ${updated} event${updated === 1 ? '' : 's'} refreshed`);
    if (realigned) {
      did.push(`Outlook: ${realigned} event${realigned === 1 ? '' : 's'} you updated by hand — Google and Outlook agree again`);
    }
    if (retired.length) {
      did.push(
        `Outlook: ${retired.length} event${retired.length === 1 ? '' : 's'} moved, renamed or cancelled — `
        + `old cop${retired.length === 1 ? 'y' : 'ies'} retired`
        + (unmirrored ? ` (${unmirrored} removed from Google)` : ''),
      );
    }

    return { ok: true, read: labels.length, parsed: events.length, added, updated, realigned, retired: retired.length };
  } catch (err) {
    await markSource(sql, 'outlook', false, err.message);
    did.push(`Outlook FAILED — ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    await ctx.close().catch(() => {});
  }
}
