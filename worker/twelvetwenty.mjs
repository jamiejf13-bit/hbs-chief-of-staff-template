// 12Twenty — read the events list and what you are registered for.
//
// Read-only. **Registration is never automatic** (spec): a matching event you
// have not signed up for becomes a to-do, and you sign up yourself. Nothing
// here clicks a register button, and there is no code path that could.
//
// Written against the real page, surveyed first. One row's first cell holds
// the title, the organisation, the event type, the date range and the
// location as separate lines; the second and third cells hold the two
// registration states, which are different things:
//
//   cell 1  REGISTRATION OPEN | REGISTRATION NOT REQUIRED | REGISTRATION CLOSED
//   cell 2  REGISTERED | NOT REGISTERED
//
// Conflating them would have read "REGISTRATION NOT REQUIRED" as "you are
// registered", which is the opposite of what it means.

import { chromium } from 'playwright';
import { PROFILE, BASE, clearStaleLocks, launchOptions, reauthenticate } from './twelvetwenty-login.mjs';
import { markSource } from './lib.mjs';
import { twelveTwentyBusy } from './lib.mjs';
import { TARGETS, has } from './targets.mjs';

/**
 * How long a 12Twenty sign-in actually lasts, measured rather than assumed.
 *
 * The cookie says thirty days and the log says otherwise: renewal worked at
 * 11:30pm, 2:31am, 4:30am and 7:31am on one sign-in, then lapsed around 4am the
 * following night. Harvard's CAS expires the ticket long before the cookie
 * carrying it, and "keep me signed in" is already ticked, so this is the floor.
 */
const LAPSES_AFTER_HOURS = 36;
const WARN_AFTER_HOURS = 26;

/**
 * What an event has to be about to be worth seeing — read from
 * lib/targets.json, the same definition the job and people scorers use.
 *
 * Wanted: every function and industry term. An event matching none of these
 * is not a weaker match, it is a different career — without this the panel
 * filled with sessions from industries nobody was recruiting in.
 *
 * Not wanted: exclude.sectors and exclude.employers, which veto an event
 * outright. To surface a particular company's events, add its name as an
 * industry term.
 *
 * Matched as words (targets.mjs `has`), not substrings, so "ai" does not
 * match inside "retail".
 */
const WANTED = [
  ...TARGETS.functions.flatMap((f) => f.terms),
  ...TARGETS.industries.flatMap((i) => i.terms),
];
const NOT_WANTED = [...(TARGETS.exclude.sectors ?? []), ...(TARGETS.exclude.employers ?? [])];

/** "09/23/2026, 5:30pm - 6:30pm EDT" and the cross-day form. */
const DATE_LINE =
  /(\d{2}\/\d{2}\/\d{4}),\s*(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(?:(\d{2}\/\d{2}\/\d{4}),\s*)?(\d{1,2}:\d{2}\s*[ap]m)\s*([A-Z]{2,4})?/i;

function parseWhen(line) {
  const m = line.match(DATE_LINE);
  if (!m) return null;
  const [, d1, t1, d2, t2] = m;
  const start = toDate(d1, t1);
  const end = toDate(d2 ?? d1, t2);
  if (!start) return null;
  return { start, end: end && end > start ? end : new Date(start.getTime() + 3600_000) };
}

function toDate(mdy, hhmm) {
  const [mm, dd, yyyy] = mdy.split('/').map(Number);
  const t = hhmm.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/);
  if (!t) return null;
  let h = Number(t[1]) % 12;
  if (t[3] === 'p') h += 12;
  return new Date(yyyy, mm - 1, dd, h, Number(t[2]), 0, 0);
}

function filtersFor(text) {
  const lower = text.toLowerCase();
  if (has(lower, NOT_WANTED)) return [];
  const hits = WANTED.filter((w) => has(lower, [w]));
  return [...new Set(hits)];
}

/**
 * Ninety days, not twenty-one.
 *
 * An event in November never appeared. The cause
 * was partly here: a 21-day horizon dropped anything further out, so an
 * event worth planning around was discarded on the way in. Recruiting
 * events are announced weeks ahead and that is exactly when they are worth
 * knowing about.
 *
 * The other half is not ours: the 12Twenty events page itself currently
 * lists only to mid-October, fully rendered, with no pagination and nothing
 * more behind a scroll. Widening the horizon means nothing is lost once the
 * page does show them.
 */
/**
 * The events list URL, asking for a wide window rather than the default week.
 *
 * The page keeps its whole query in a base64  parameter, and
 * its default is ONE WEEK at a time with a page size of 50. So the reader saw
 * one week and nothing else — which is why an event in November never
 * appeared. It was not a scrolling problem: the table renders in full,
 * with no pagination controls and nothing behind a scroll. The list simply
 * was not being asked for those dates.
 *
 * Only the date range and page size are changed. Every other filter is left
 * exactly as 12Twenty had it, because they are its own and guessing at them
 * is how a reader starts silently excluding things.
 */
function eventsUrl(days) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + days * 86_400_000);

  const criteria = {
    ShouldCalculateTotal: false,
    PageNumber: 1,
    PageSize: 250,
    ShouldCalculatePaging: true,
    IsSortAsc: true,
    sortBy: 1,
    Filters: [],
    StudentGroupIds: [],
    IsForCalendarView: false,
    View: {
      viewName: 'list',
      listViewDateRange: { Start: start.toISOString(), End: end.toISOString() },
      activeStart: start.toISOString(),
      activeEnd: end.toISOString(),
    },
  };
  const q = Buffer.from(JSON.stringify(criteria), 'utf8').toString('base64');
  return `${BASE}/events#/events?queryCriteria=${encodeURIComponent(q)}`;
}
export async function syncTwelveTwenty(sql, env, did, { days = 90 } = {}) {
  // Stand down while a sign-in window is open — the profile holds one browser.
  if (await twelveTwentyBusy(sql)) {
    return { ok: true, skipped: true, reason: 'a 12Twenty sign-in window is open' };
  }

  clearStaleLocks();

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, launchOptions({ headless: true }));
  } catch (err) {
    await markSource(sql, '12twenty', false, err.message);
    return { ok: false, reason: err.message };
  }

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    /**
     * Load the app first, THEN ask it for the window we want.
     *
     * A hash route handed to an unbooted Angular app is not reliably honoured,
     * so the plain events page goes first and the hash changes afterwards —
     * a same-document change the router handles itself.
     *
     * (This was first written blaming the deep link for a "session expired"
     * that turned out to be a bot challenge. The two-step navigation is still
     * the right shape; it just was not the cause.)
     */
    await page.goto(`${BASE}/Events`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);

    if (/login|microsoftonline|cas\.hbs/i.test(page.url())) {
      /**
       * Tell a bot challenge apart from an expired session.
       *
       * 12Twenty sits behind a bot-protection service that starts demanding
       * verification when it sees several automated visits close together —
       * which it did once after this was run six or seven times
       * in a few minutes while a change was being tested. The reader said
       * "session expired", and the fix for that would not have helped: the
       * session was fine and the service simply wanted a pause.
       *
       * Reading the page rather than only the URL costs one evaluate and
       * saves being sent to do the wrong thing.
       *
       * The first version of this said to wait an hour because it "usually"
       * clears. It does not: 23 hours later it was still blocking. Only a
       * person completing the check in a real window clears it, and the
       * login script is what opens one.
       */
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');
      const challenged =
        /security verification|malicious bots|checking your browser|are you a human/i.test(body);

      /**
       * An expired session is not a dead end — renew it here.
       *
       * 12Twenty's session cookie lasts twelve hours, so this branch was being
       * reached twice a day, and every time it said to go and sign in by
       * hand. The thirty-day CAS ticket in the profile can mint a new session
       * on its own; reauthenticate clicks the SSO link and waits for the chain.
       * Only when that fails has the long ticket actually lapsed.
       *
       * A bot check is skipped — clicking through a challenge page is both
       * futile and the wrong thing to be doing.
       */
      if (!challenged && (await reauthenticate(page))) {
        did.push('12Twenty session renewed itself (no sign-in needed)');

        /**
         * Reload, not goto.
         *
         * SSO lands on `/Events#/events`, so a goto to `/Events` differs from
         * the current URL only by the hash — which the browser treats as a
         * same-document change and does not reload. Angular was therefore
         * never re-bootstrapped against the new session, and the first version
         * of this renewed the session perfectly and then read zero events,
         * while the very next run on the warm session read 52.
         */
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(6000);
      } else {
        const why = challenged
          ? '12Twenty is showing a bot check. Run "node worker/twelvetwenty-login.mjs" and complete the verification once in the window it opens — it does NOT clear on its own; it was still blocking 23 hours later.'
          : '12Twenty needs a sign-in — Harvard SSO expires its ticket after about a day and a half, whatever the cookie says. Run "node worker/twelvetwenty-login.mjs"';
        await markSource(sql, '12twenty', false, why);
        did.push(`12Twenty FAILED — ${why}`);
        return { ok: false, reason: why };
      }
    }

    // Angular renders the list after its data call; waiting on the rows
    // themselves is the only reliable signal.
    // Now the router exists, hand it the ninety-day window.
    await page.evaluate((u) => { window.location.hash = u.split("#")[1]; }, eventsUrl(days));
    await page.waitForTimeout(7000);

    try {
      await page.waitForFunction(() => document.querySelectorAll('tr').length > 3, { timeout: 30_000 });
    } catch { /* fall through — an empty list is a real answer */ }
    await page.waitForTimeout(2500);

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('tr')]
        .filter((r) => (r.innerText || '').trim().length > 40)
        .map((r) => {
          const cells = [...r.querySelectorAll('td')];
          return {
            // Kept as lines, not collapsed: the line breaks are what separate
            // title from organisation from type from date from location.
            lines: (cells[0]?.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
            registration: (cells[1]?.innerText ?? '').trim(),
            registered: (cells[2]?.innerText ?? '').trim(),
            href: r.querySelector('a')?.getAttribute('href') ?? null,
          };
        }),
    );

    const horizon = Date.now() + days * 86_400_000;
    let updated = 0, matched = 0, registered = 0, queued = 0;

    for (const row of rows) {
      const id = (row.href ?? '').match(/events\/(\d+)/)?.[1];
      if (!id) continue;

      const whenLine = row.lines.find((l) => DATE_LINE.test(l));
      const when = whenLine ? parseWhen(whenLine) : null;
      if (!when) continue;
      if (when.start.getTime() > horizon) continue;

      const title = row.lines[0];
      if (!title) continue;
      const whenIdx = row.lines.indexOf(whenLine);
      const location = row.lines.slice(whenIdx + 1).join(' · ') || null;
      const context = row.lines.join(' ');

      const isRegistered = /\bREGISTERED\b/i.test(row.registered) && !/NOT REGISTERED/i.test(row.registered);
      if (isRegistered) registered++;

      const filters = filtersFor(context);
      if (filters.length) matched++;

      const url = `${BASE}/events#/events/${id}`;

      const [existing] = await sql`
        select id from events where source = '12twenty' and source_id = ${id} limit 1`;

      if (existing) {
        await sql`
          update events set title = ${title}, start_at = ${when.start.toISOString()},
                 end_at = ${when.end.toISOString()}, location = ${location},
                 url = ${url},
                 -- registered is the owner's once the prompt is cleared; before that,
                 -- 12Twenty is the better authority.
                 registered = case when recruiting_dismissed then registered else ${isRegistered} end,
                 matched_filters = ${filters}, deleted_at = null
           where id = ${existing.id}`;
      } else {
        await sql`
          insert into events (title, start_at, end_at, location, source, source_id,
                              url, registered, matched_filters, seen_in)
          values (${title}, ${when.start.toISOString()}, ${when.end.toISOString()},
                  ${location}, '12twenty', ${id}, ${url}, ${isRegistered},
                  ${filters}, ${['12twenty']})`;
      }
      updated++;

      /**
       * A matching event you have not signed up for becomes a to-do.
       *
       * Never a registration. The spec is explicit that signing up is yours,
       * and an agent that registers you for things is exactly the behaviour
       * that would make you stop trusting it.
       */
      const openForSignup = /REGISTRATION OPEN/i.test(row.registration);
      if (filters.length && openForSignup && !isRegistered && when.start.getTime() > Date.now()) {
        const res = await sql`
          insert into tasks (title, origin, source, source_id, category, due_at,
                             est_minutes, url, notes)
          values (${`Sign up — ${title}`}, 'mirrored', '12twenty', ${`event/${id}`},
                  'recruiting', ${new Date(when.start.getTime() - 3600_000).toISOString()},
                  5, ${url}, ${`Matched: ${filters.join(', ')}. ${location ?? ''}`.trim()})
          on conflict do nothing
          returning id`;
        if (res.length) queued++;
      }
    }

    /**
     * Say something while it can still be acted on.
     *
     * The sign-in lasts about thirty-six hours. Warning at twenty-six leaves
     * most of a day to do something about it — and because this worker only
     * runs on the laptop, the warning can only appear when you are at the
     * machine that can answer it. That is the whole point: the error
     * notification arrived wherever you happened to be, which was usually a
     * phone, where signing in is impossible.
     */
    const [pref] = await sql`select twelvetwenty_signed_in_at from prefs where id = true`;
    const signedIn = pref?.twelvetwenty_signed_in_at
      ? Date.parse(pref.twelvetwenty_signed_in_at)
      : null;
    const hours = signedIn === null ? null : (Date.now() - signedIn) / 3600_000;

    const warning =
      hours !== null && hours > WARN_AFTER_HOURS
        ? `Sign in to 12Twenty when you get a moment — it has been ${Math.round(hours)}h and ` +
          `the session lapses around ${LAPSES_AFTER_HOURS}h. ` +
          'Run "node worker/twelvetwenty-login.mjs"'
        : null;

    if (warning) did.push(warning);
    await markSource(sql, '12twenty', true, null, warning);
    if (updated) did.push(`12Twenty: ${updated} event${updated === 1 ? '' : 's'} read, ${matched} matching your filters`);
    if (queued) did.push(`12Twenty: ${queued} sign-up${queued === 1 ? '' : 's'} added to your list — you register, not me`);

    return { ok: true, read: rows.length, updated, matched, registered, queued };
  } catch (err) {
    await markSource(sql, '12twenty', false, err.message);
    did.push(`12Twenty FAILED — ${String(err.message).slice(0, 120)}`);
    return { ok: false, reason: err.message };
  } finally {
    await ctx.close().catch(() => {});
  }
}
