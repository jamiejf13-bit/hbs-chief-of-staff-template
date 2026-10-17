// The action executor: the only place the worker changes anything outward.
//
// It acts ONLY on rows the owner has already approved. Nothing here runs on the
// worker's own judgement — status goes 'pending' → (they tap) → 'approved',
// and only then does this touch a calendar.
//
// Tier 3 work (money, professors, cold recruiters, Canvas submissions) is not
// implemented at all, deliberately. Email is not implemented either: the send
// path ships behind EMAIL_SEND_ENABLED and that feature does not exist yet.

import { chromium } from 'playwright';
import { PROFILE, clearStaleLocks } from './outlook.mjs';
import {
  PROFILE as TT_PROFILE,
  BASE as TT_BASE,
  clearStaleLocks as ttClearLocks,
  launchOptions as ttLaunchOptions,
  reauthenticate as ttReauth,
} from './twelvetwenty-login.mjs';
import { googleRefreshToken } from './lib.mjs';
// Aliased: PROFILE above is the Outlook browser-profile path.
import { PROFILE as ME } from './profile.mjs';


/** Actions this worker knows how to carry out. Anything else is left pending
 *  rather than silently marked done. */
const HANDLERS = {
  mirror_to_outlook: mirrorToOutlook,
  remove_stale_event: removeStaleEvent,
  create_calendar_event: createCalendarEvent,
  update_event_time: updateEventTime,
  register_event: registerForEvent,
  refresh_mail: refreshMail,
  twelvetwenty_login: openTwelveTwentyLogin,
  google_auth: openGoogleAuth,
};

export async function runApprovedActions(sql, env, did, { limit = 5 } = {}) {
  /**
   * Put back anything left stranded in 'executing'.
   *
   * The status is set before the handler runs, so a worker killed mid-action
   * — a laptop sleeping, a restart, a crash — leaves the row claimed for ever.
   * Nothing retries it, and worse, the duplicate guard treats 'executing' as
   * in-flight, so pressing "Sign me up" again is silently ignored: the event
   * is never registered and the button appears to do nothing.
   *
   * A registration that genuinely takes more than ten minutes does not exist;
   * the browser timeouts inside it are far shorter.
   */
  const stranded = await sql`
    update actions set status = 'approved'
     where status = 'executing' and created_at < now() - interval '10 minutes'
     returning id, summary`;
  for (const a of stranded) {
    did.push(`Retrying "${a.summary}" — it was interrupted`);
  }

  const rows = await sql`
    select id, type, summary, payload, note
      from actions
     where status = 'approved'
     order by created_at
     limit ${limit}`;

  if (!rows.length) return { ok: true, executed: 0 };

  let done = 0, failed = 0;

  for (const action of rows) {
    const handler = HANDLERS[action.type];
    if (!handler) {
      did.push(`Action left pending — nothing implements "${action.type}" yet`);
      continue;
    }

    await sql`update actions set status = 'executing' where id = ${action.id}`;

    try {
      const note = await handler(sql, env, action);
      await sql`update actions set status = 'done', resolved_at = now(), error = null where id = ${action.id}`;
      did.push(note ?? `Done: ${action.summary}`);
      done++;
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 400);
      await sql`update actions set status = 'failed', resolved_at = now(), error = ${message} where id = ${action.id}`;
      did.push(`FAILED: ${action.summary} — ${message.slice(0, 120)}`);
      failed++;
    }
  }

  return { ok: failed === 0, executed: done, failed };
}

/* ------------------------------------------------------------------ */

/** A Google access token from the stored refresh token. */
async function googleToken(env) {
  const refreshToken = googleRefreshToken(env);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tok = await res.json();
  if (!res.ok) {
    throw new Error(tok.error === 'invalid_grant'
      ? 'Google refresh token rejected — run "node worker/google-auth.mjs"'
      : `Google auth failed: ${tok.error_description || tok.error}`);
  }
  return tok.access_token;
}

/**
 * An event the owner created in the console. Put it in Google, then Outlook.
 *
 * Google first, because it is an API call that either works or reports why.
 * Outlook is browser automation and the slower, more fragile half — so if it
 * fails, the event still exists in one real calendar and the row says the
 * Outlook side is outstanding, rather than the whole thing being lost.
 */
async function createCalendarEvent(sql, env, action) {
  const { event_id } = action.payload ?? {};
  if (!event_id) throw new Error('action payload is missing event_id');

  const [ev] = await sql`
    select id, title, start_at, end_at, location, source_id
      from events where id = ${event_id} and deleted_at is null limit 1`;
  if (!ev) return 'That event was removed before it could be created';
  if (ev.source_id) return `"${ev.title}" is already in Google`;

  const token = await googleToken(env);
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: ev.title,
      location: ev.location ?? undefined,
      start: { dateTime: new Date(ev.start_at).toISOString() },
      end: { dateTime: new Date(ev.end_at ?? Date.parse(ev.start_at) + 3600_000).toISOString() },
      extendedProperties: { private: { cos_origin: 'console', cos_event: String(ev.id) } },
    }),
  });
  const created = await res.json();
  if (!res.ok) throw new Error(`Google refused the event: ${created.error?.message ?? res.statusText}`);

  await sql`
    update events
       set source_id = ${created.id}, sync_state = 'synced', sync_error = null,
           seen_in = ${['gcal']}
     where id = ${ev.id}`;

  try {
    await pushToOutlook(ev.title, ev.start_at, ev.end_at, ev.location);
    await sql`update events set seen_in = ${['outlook', 'gcal']} where id = ${ev.id}`;
    return `Added "${ev.title}" to Google and Outlook`;
  } catch (err) {
    await sql`
      update events set sync_state = 'failed',
             sync_error = ${`In Google. Outlook failed: ${String(err?.message ?? err).slice(0, 200)}`}
       where id = ${ev.id}`;
    return `Added "${ev.title}" to Google. Outlook did not take it — see the event for why`;
  }
}

/**
 * A time or title change made in the console.
 *
 * **Google is updated; Outlook is not.** Outlook has no write API here and
 * editing an existing item through the browser means locating it in the grid
 * and driving a dialog — fragile enough that a wrong hit would corrupt a real
 * appointment. Creating is safe because a stray new event is obvious and
 * harmless; editing is not.
 *
 * Google is therefore the master, which is also how the owner works. The Outlook
 * twin is hidden behind its Google row and the change Outlook still needs is
 * recorded on the event, so the console shows one commitment at the right
 * time and one clear instruction — rather than the same thing twice, once at
 * each time, which is what it used to do.
 */
async function updateEventTime(sql, env, action) {
  const ids = action.payload?.event_ids ?? [];
  if (!ids.length) throw new Error('action payload is missing event_ids');

  const rows = await sql`
    select id, title, start_at, end_at, location, source, source_id, all_day
      from events where id = any(${ids}) and deleted_at is null`;
  if (!rows.length) return 'Those events are gone';

  // An all-day event is a calendar day, not an instant. Google rejects a
  // dateTime for one outright — "Invalid start time" — which is how this was
  // found, on a birthday that had been nudged in the grid.
  const allDay = rows.find((r) => r.all_day);
  if (allDay) {
    for (const r of rows) {
      await sql`
        update events
           set sync_state = 'synced', sync_error = null
         where id = ${r.id}`;
    }
    return `"${allDay.title}" is an all-day event — left as it is rather than rewritten with a time`;
  }

  const token = await googleToken(env);
  let pushed = 0;

  for (const ev of rows.filter((r) => r.source === 'gcal' && r.source_id)) {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(ev.source_id)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          summary: ev.title,
          location: ev.location ?? undefined,
          start: { dateTime: new Date(ev.start_at).toISOString() },
          end: { dateTime: new Date(ev.end_at ?? Date.parse(ev.start_at) + 3600_000).toISOString() },
        }),
      },
    );
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(`Google refused the change: ${b.error?.message ?? res.statusText}`);
    }
    await sql`update events set sync_state = 'synced', sync_error = null where id = ${ev.id}`;
    pushed++;
  }

  /**
   * Google is the master; Outlook is a follower updated by hand.
   *
   * HBS blocks every route to writing Outlook — Microsoft's own Graph
   * Explorer is refused for this account outright (AADSTS50105, the tenant
   * requires per-app assignment), so there is no API to fall back to. The
   * change is real in Google and stale in Outlook, and the useful thing is to
   * say exactly what Outlook still needs.
   *
   * The stale Outlook twin is hidden behind its Google row rather than left
   * loose: otherwise the next Outlook read pulls it back to its old time, it
   * no longer shares a 15-minute bucket with its twin, and the console draws
   * the same commitment twice — once at the new time and once at the old.
   */
  const outlookRows = rows.filter((r) => r.source === 'outlook');
  const googleRow = rows.find((r) => r.source === 'gcal') ?? null;

  for (const ev of outlookRows) {
    /**
     * The time to quote is the NEW one, which lives on the Google row.
     *
     * Reading it off the Outlook row gives its old time, so the instruction
     * would have read "move it to 4:30" when 4:30 is exactly where Outlook
     * already had it — a note saying to do nothing, on an event that
     * needed moving.
     */
    const target = googleRow ?? ev;
    const when = new Date(target.start_at).toLocaleString('en-US', {
      timeZone: ME.timezone || 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit',
    });
    const had = new Date(ev.start_at).toLocaleString('en-US', {
      timeZone: ME.timezone || 'America/New_York', hour: 'numeric', minute: '2-digit',
    });
    const asks = `Outlook still has this at ${had} — move it to ${when} there by hand.`;

    await sql`
      update events
         set sync_state = 'failed', sync_error = ${asks},
             duplicate_of = ${googleRow ? googleRow.id : null}
       where id = ${ev.id}`;

    if (googleRow) {
      await sql`update events set outlook_needs = ${asks} where id = ${googleRow.id}`;
    }
  }

  /**
   * Nothing is left saying "waiting for the laptop" once the laptop has been.
   *
   * Only Google rows were ever cleared, so a 12Twenty or console-owned row
   * kept its 'pending' marker for ever — one session showed "waiting for
   * the laptop to put it in Google and Outlook" for days, on an action that
   * finished the same minute. A status
   * that can never resolve is worse than no status: it trains you to ignore
   * the one that means something.
   *
   * Parked Outlook rows are left alone: their 'failed' state is the real
   * outstanding work, and it clears itself when Outlook catches up.
   */
  await sql`
    update events set sync_state = 'synced', sync_error = null
     where id = any(${ids}) and sync_state = 'pending' and duplicate_of is null`;

  const note = `Updated ${pushed} event${pushed === 1 ? '' : 's'} in Google`;
  return outlookRows.length ? `${note}. Outlook still needs the same change by hand` : note;
}


/**
 * Register the owner for a 12Twenty event.
 *
 * The original spec said registration is never automatic; that was changed
 * deliberately — sign-ups should just happen rather than become a to-do — so
 * this exists. It still only ever runs from an action the owner
 * asked for by name; nothing here decides on its own that an event is worth
 * attending.
 *
 * The title on the page is checked against the title in the database before
 * anything is clicked. Registering for the wrong event is not something
 * that can be undone quietly, and a stale id or a reused URL is exactly how
 * that would happen.
 */
async function registerForEvent(sql, env, action) {
  const { event_id } = action.payload ?? {};
  if (!event_id) throw new Error('action payload is missing event_id');

  const [ev] = await sql`
    select id, title, source, source_id, url, registered
      from events where id = ${event_id} and deleted_at is null limit 1`;
  if (!ev) return 'That event is gone';
  if (ev.registered) return `Already registered for "${ev.title}"`;
  if (ev.source !== '12twenty') {
    throw new Error(`"${ev.title}" is not a 12Twenty event — registration only works there`);
  }

  ttClearLocks();
  const ctx = await chromium.launchPersistentContext(
    TT_PROFILE,
    ttLaunchOptions({ headless: true, viewport: { width: 1400, height: 1000 } }),
  );

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(ev.url ?? `${TT_BASE}/events#/events/${ev.source_id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    if (/login|microsoftonline|cas\.hbs/i.test(page.url())) {
      /**
       * A bot check is not an expired session, and the fix is different.
       *
       * This said "session expired" for both, so three failed registrations
       * pointed at a login script that would not have helped — 12Twenty was
       * throttling automated visits, which only a person completing the
       * verification clears. The events reader learned this first;
       * this path did not, because the two guards were written separately.
       */
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');
      const challenged =
        /security verification|malicious bots|checking your browser|are you a human/i.test(body);

      // Same renewal the reader does. A registration that gave up here left
      // one stuck for a day waiting on a sign-in it did not need.
      if (!challenged && (await ttReauth(page))) {
        await page.goto(ev.url ?? `${TT_BASE}/events#/events/${ev.source_id}`, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await page.waitForTimeout(3000);
      } else {
        throw new Error(
          challenged
            ? '12Twenty is showing a bot check — run "node worker/twelvetwenty-login.mjs" and complete the verification once in the window it opens'
            : '12Twenty needs a sign-in — Harvard SSO expires its ticket after about a day and a half, whatever the cookie says. Run "node worker/twelvetwenty-login.mjs"',
        );
      }
    }

    try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); } catch { /* Angular keeps polling */ }
    await page.waitForTimeout(3500);

    /**
     * The page must be showing the event we think it is.
     *
     * This used to read `querySelector('h1,h2,h3')` — the FIRST heading in the
     * document, which on 12Twenty is the masthead. Every registration was
     * refused with "the page says Harvard Business School", including events
     * asked for by name. The guard was right to exist
     * and wrong about where to look.
     *
     * Now every heading is considered, and the visible text is the fallback.
     * The check is still a real one: we arrived at a URL built from this row's
     * own source_id, so this is guarding against a redirect to some other
     * page, and a redirect would not carry the event's title anywhere on it.
     */
    const { headings, body: shown } = await page.evaluate(() => ({
      headings: [...document.querySelectorAll('h1,h2,h3,h4,[class*="title" i]')]
        .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 40),
      body: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim(),
    }));

    const shared = ev.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const need = Math.min(2, shared.length);
    const hits = (text) => shared.filter((w) => text.toLowerCase().includes(w)).length;
    const best = Math.max(0, ...headings.map(hits));

    if (!shared.length || (best < need && hits(shown) < need)) {
      const saw = headings.find(Boolean) ?? shown.slice(0, 60);
      throw new Error(`The page says "${saw.slice(0, 60)}" but the event is "${ev.title}" — not registering`);
    }

    const already = await page.evaluate(() => document.body.innerText);
    if (/You registered for this event/i.test(already)) {
      await sql`update events set registered = true where id = ${ev.id}`;
      return `Already registered for "${ev.title}" on 12Twenty`;
    }

    const register = page.locator('button:has-text("Register Now"), a:has-text("Register Now")').first();
    if (!(await register.count())) {
      if (/registration closed|no longer available/i.test(already)) {
        throw new Error(`Registration is closed for "${ev.title}"`);
      }
      throw new Error(`No Register button on the page for "${ev.title}"`);
    }

    /**
     * "Register Now" opens a SECOND TAB, and that is where registration
     * happens.
     *
     * This once cost a registration. The click fired, the first tab
     * did not change by one pixel, and the handler reported that the page
     * would not confirm — while the confirmation step sat waiting on a tab
     * nobody had looked at. Nothing was wrong with the click.
     */
    const [form] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 30_000 }),
      register.click({ timeout: 15_000 }),
    ]);

    await form.waitForLoadState('domcontentloaded');
    try { await form.waitForLoadState('networkidle', { timeout: 20_000 }); } catch { /* Angular */ }
    await form.waitForTimeout(3000);

    // "Are you sure you want to register for this event?" — Cancel | Register.
    // Both are <a role="button">, not <button>, so this asks by role.
    const confirm = form.getByRole('button', { name: 'Register', exact: true }).first();
    if (!(await confirm.count())) {
      const shown = (await form.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      throw new Error(`The registration form for "${ev.title}" is asking for something else: ${shown.slice(-200)}`);
    }
    await confirm.click({ timeout: 15_000 });
    await form.waitForTimeout(6000);

    /**
     * What 12Twenty actually says when it works.
     *
     * The old check looked for the word "REGISTERED", which appears nowhere on
     * either page. The form says "Registration Complete"; the event page, once
     * reloaded, says "You registered for this event on <date>" and offers
     * "Cancel Registration". Both are checked, and the event page is the one
     * that decides — it is the durable record rather than a transient screen.
     */
    const done = await form.evaluate(() => document.body.innerText);
    await page.reload({ waitUntil: 'domcontentloaded' });
    try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); } catch { /* Angular */ }
    await page.waitForTimeout(3500);
    const after = await page.evaluate(() => document.body.innerText);

    const ok = /You registered for this event/i.test(after)
      || /Cancel Registration/i.test(after)
      || /Registration Complete/i.test(done);

    if (!ok) {
      throw new Error(`Clicked register for "${ev.title}" but the page does not confirm it — check 12Twenty`);
    }

    await sql`update events set registered = true where id = ${ev.id}`;
    // The sign-up to-do, if one was raised for this event, is now done.
    await sql`
      update tasks set done = true, done_at = now()
       where source = '12twenty' and source_id = ${`event/${ev.source_id}`} and not done`;

    return `Registered you for "${ev.title}" on 12Twenty`;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * The owner confirmed a Google-only event is real: put it in Outlook too.
 *
 * Outlook has no write API here, and JavaScript is blocked on the domain, so
 * this uses the prefilled compose deeplink and clicks Save. Deeplink times are
 * UTC with a trailing Z; Outlook renders them local.
 */
async function mirrorToOutlook(sql, env, action) {
  const { title, start_at, location, event_id } = action.payload ?? {};
  if (!title || !start_at) throw new Error('action payload is missing title or start_at');

  await pushToOutlook(title, start_at, null, location, action.note);

  if (event_id) {
    await sql`update events set seen_in = ${['outlook', 'gcal']} where id = ${event_id}`;
  }
  return `Added "${title}" to Outlook`;
}

/**
 * Create one event in Outlook through the prefilled compose deeplink.
 *
 * Outlook has no usable write API on the HBS tenant and JavaScript injection
 * is blocked on the domain, so this is the only path. Deeplink times are UTC
 * with a trailing Z; Outlook renders them local.
 */
export async function pushToOutlook(title, startAt, endAt, location, note) {
  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : new Date(start.getTime() + 60 * 60_000);
  const z = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // The note goes in the body, where it is seen next time the event is
  // opened — the reason for a decision is most useful next to the decision.
  const body = note
    ? `${note}\n\n— added by ${ME.appName}, confirmed by you.`
    : `Added by ${ME.appName}, confirmed by you.`;

  const url =
    'https://outlook.cloud.microsoft/calendar/deeplink/compose' +
    `?subject=${encodeURIComponent(title)}` +
    `&startdt=${z(start)}&enddt=${z(end)}` +
    (location ? `&location=${encodeURIComponent(location)}` : '') +
    `&body=${encodeURIComponent(body)}`;

  clearStaleLocks();
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);

    if (/login\.microsoftonline|\/auth\//i.test(page.url())) {
      throw new Error('Outlook session expired — run "node worker/outlook-login.mjs"');
    }

    const save = page.locator('button[aria-label^="Save"], button:has-text("Save")').first();
    await save.click({ timeout: 20_000 });
    await page.waitForTimeout(4000);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * The owner confirmed a Google-only event was cancelled: remove it from Google.
 *
 * Destructive, so it is only ever reached from an approved action — never
 * from the worker deciding an absence means deletion.
 */
async function removeStaleEvent(sql, env, action) {
  const { event_id } = action.payload ?? {};
  if (!event_id) throw new Error('action payload is missing event_id');

  const [ev] = await sql`select id, title, source, source_id from events where id = ${event_id} limit 1`;
  if (!ev) return 'That event is already gone';
  if (ev.source !== 'gcal') throw new Error(`refusing to delete a ${ev.source} event through this path`);

  const refreshToken = googleRefreshToken(env);
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tok = await tokRes.json();
  if (!tokRes.ok) throw new Error(`Google auth failed: ${tok.error_description || tok.error}`);

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(ev.source_id)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${tok.access_token}` } },
  );
  // 410 means it was already deleted upstream, which is the outcome we wanted.
  if (!res.ok && res.status !== 410 && res.status !== 404) {
    throw new Error(`Google refused the delete: ${res.status} ${res.statusText}`);
  }

  await sql`update events set deleted_at = now() where id = ${ev.id}`;
  return `Removed "${ev.title}" from Google Calendar`;
}

export { mirrorToOutlook, removeStaleEvent };

/**
 * Registered 12Twenty events, into Outlook as well as Google.
 *
 * Google is written through its API in gcal.mjs. Outlook has no API available
 * here, so this drives the compose deeplink and clicks Save — the same path
 * that mirrors a Google-only event, and the only one HBS leaves open.
 *
 * Kept apart from the Google mirror rather than bolted onto it, because the
 * two fail in completely different ways: an API error is immediate and
 * precise, a browser failure is slow and vague. Either can succeed while the
 * other does not, and the row records them separately so a retry does not
 * duplicate the half that worked.
 *
 * One at a time, and few per pass: each one launches a browser, loads a
 * compose form and waits for a save. Nine in a row would hold the profile for
 * minutes and block the calendar sync that needs it.
 */
export async function mirrorRegisteredToOutlook(sql, env, did, { limit = 4 } = {}) {
  const rows = await sql`
    select id, title, start_at, end_at, location
      from events
     where source = '12twenty' and registered and deleted_at is null
       and outlook_mirrored_at is null
       and start_at > now()
     order by start_at
     limit ${limit}`;

  if (!rows.length) return { ok: true, added: 0 };

  let added = 0;
  const failures = [];

  for (const ev of rows) {
    try {
      // Claimed first, as everywhere that writes outward: a crash between the
      // save and the record would otherwise add it again next pass.
      const claim = await sql`
        update events set outlook_mirrored_at = now()
         where id = ${ev.id} and outlook_mirrored_at is null
         returning id`;
      if (!claim.length) continue;

      await pushToOutlook(
        ev.title,
        ev.start_at,
        ev.end_at,
        ev.location,
        'You registered for this on 12Twenty.',
      );
      added++;
    } catch (err) {
      await sql`update events set outlook_mirrored_at = null where id = ${ev.id}`
        .catch(() => { /* the database is what failed */ });
      failures.push(`${ev.title.slice(0, 30)}: ${String(err.message).slice(0, 70)}`);
      if (failures.length >= 2) break; // stop hammering a broken browser path
    }
  }

  if (added) did.push(`Added ${added} registered event${added === 1 ? '' : 's'} to Outlook`);
  for (const f of failures) did.push(`Outlook copy FAILED — ${f}`);

  return { ok: failures.length === 0, added, failed: failures.length };
}

/**
 * Re-read the mailbox because you asked, rather than because it was due.
 *
 * Mail cleared in Outlook would otherwise still show in the console,
 * and the scheduled pass is twenty minutes away. This is that pass, now.
 *
 * It calls the same reader the loop calls, so there is one implementation of
 * what "read the mail" means. Importing it here rather than the other way
 * round keeps gcal.mjs and outlook-mail.mjs free of a dependency on the
 * action executor.
 */
async function refreshMail(sql, env) {
  const { syncOutlookMail } = await import('./outlook-mail.mjs');
  const did = [];
  const r = await syncOutlookMail(sql, env, did);
  if (!r.ok) throw new Error(r.reason ?? 'the mailbox could not be read');
  return did.length ? did.join(' · ') : 'Mailbox re-read — nothing new';
}

/**
 * Open the 12Twenty sign-in window on the laptop.
 *
 * Harvard's CAS expires its ticket after about a day and a half, whatever the
 * cookie claims, and nothing here can change a university's session policy.
 * What it can change is what that costs you: otherwise it means finding a
 * terminal and typing a path, which is a poor answer to something that happens
 * every other day — and impossible from a phone, which is usually where the
 * notification arrives.
 *
 * So the console gets a button, and the button lands here. It cannot sign you
 * in — that needs your Harvard password, which is yours to type and nothing here
 * will ever enter — but it can put the window in front of you with one click.
 *
 * Detached and NOT awaited. The login script waits up to eight minutes for you
 * to finish; awaiting it would wedge the worker loop for that whole time, and
 * the wedged-tick guard would then kill the worker out from under the window
 * being typed into.
 */
async function openTwelveTwentyLogin(sql) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  // Claim the profile before spawning, so the reader that runs moments later
  // in this same pass stands down rather than racing the window you are about
  // to type into.
  const { holdTwelveTwenty } = await import('./lib.mjs');
  await holdTwelveTwenty(sql, 10);

  const script = fileURLToPath(new URL('./twelvetwenty-login.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    cwd: fileURLToPath(new URL('../', import.meta.url)),
  });
  child.unref();

  return 'Sign-in window opening on the laptop — complete it there and 12Twenty will resume';
}

/**
 * Open the Google reconnect window on the laptop.
 *
 * Google expires refresh tokens after seven days for any OAuth app whose
 * publishing status is Testing, which is why this had been needed weekly.
 * Leaving Testing requires a home page and a privacy policy on a domain the
 * developer owns — Google will not accept a shared one like vercel.app.
 *
 * If your own domain (your-domain.com) serves /about and /privacy, the app can be
 * published and the seven-day clock stops. This stays regardless: a token can
 * still be revoked, or go unused for six months, and when that happens the
 * answer should be a button rather than a path pasted into a terminal — which
 * can fail on Windows anyway, where PowerShell may refuse to run npm.
 *
 * Detached, like the 12Twenty sign-in: google-auth.mjs runs a local web server
 * and waits for you to approve in the browser, and awaiting that would wedge
 * the worker until you did.
 */
async function openGoogleAuth() {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  const script = fileURLToPath(new URL('./google-auth.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    cwd: fileURLToPath(new URL('../', import.meta.url)),
  });
  child.unref();

  return 'Google consent window opening on the laptop — approve it there and Calendar, Gmail and Drive resume';
}

/**
 * Just the sign-in windows, for the loop that runs them promptly.
 *
 * Separate from runApprovedActions because these are the only actions you
 * press a button for and then watch. The rest can wait their turn in a
 * pass; these cannot, and they are also the only ones that do not touch a
 * browser profile a pass might be using.
 */
export async function runSignInActions(sql, env, did) {
  const rows = await sql`
    select id, type, summary
      from actions
     where status = 'approved'
       and type in ('twelvetwenty_login', 'google_auth')
       and (expires_at is null or expires_at > now())
     order by created_at
     limit 2`;

  for (const action of rows) {
    const handler = HANDLERS[action.type];
    if (!handler) continue;
    await sql`update actions set status = 'executing' where id = ${action.id}`;
    try {
      const note = await handler(sql, env, action);
      await sql`update actions set status = 'done', resolved_at = now(), error = null
                 where id = ${action.id}`;
      if (note) did.push(note);
    } catch (err) {
      await sql`update actions set status = 'failed', resolved_at = now(), error = ${String(err.message).slice(0, 300)}
                 where id = ${action.id}`;
      did.push(`Could not open the sign-in window — ${String(err.message).slice(0, 80)}`);
    }
  }
  return rows.length;
}
