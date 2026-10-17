// Google Calendar — read, and mirror Outlook into it.
//
// Google is the only calendar with a write API, so it is where events get
// created. It is NOT the source of truth: the owner maintains Outlook, and Google
// drifts. See spec §1a — neither is master, and nothing is ever deleted from
// one because the other lacks it.

import { markSource, googleRefreshToken } from './lib.mjs';
import { PROFILE } from './profile.mjs';

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

let cachedToken = null;
let cachedUntil = 0;

/** Exchange the stored refresh token for an access token, cached until it expires. */
async function accessToken(env) {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

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
    // invalid_grant is the seven-day Testing-mode expiry, or a revoked token.
    // It is a first-class state: surface it, never fail silently (spec §8).
    const why = tok.error === 'invalid_grant'
      ? 'Google refresh token rejected — re-run "node worker/google-auth.mjs". This happens every 7 days while the app is unpublished.'
      : `Google token refresh failed: ${tok.error_description || tok.error}`;
    throw new Error(why);
  }

  cachedToken = tok.access_token;
  cachedUntil = Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000;
  return cachedToken;
}

async function api(env, url, init = {}) {
  const token = await accessToken(env);
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${body.slice(0, 160)}`);
  }
  // A successful DELETE answers 204 with no body, and `res.json()` on an
  // empty body throws "Unexpected end of JSON input" — which read as ten
  // failed deletions when in fact every one of them had worked.
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * An all-day event carries `start.date` — a calendar day, not an instant.
 *
 * Reading it as midnight UTC was wrong: rendered in Eastern time that is 8pm
 * the evening before, which put every birthday on the wrong day. Anchoring to
 * local midnight keeps the day correct, and `all_day` records what it is so
 * it is never written back to Google as a timed event.
 */
function isoOf(ev) {
  if (ev.start?.dateTime) return ev.start.dateTime;
  if (!ev.start?.date) return null;
  const [y, m, d] = ev.start.date.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function endOf(ev) {
  if (ev.end?.dateTime) return ev.end.dateTime;
  if (!ev.end?.date) return null;
  const [y, m, d] = ev.end.date.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

const isAllDay = (ev) => Boolean(ev.start?.date && !ev.start?.dateTime);

export async function syncGoogleCalendar(sql, env, did, { days = 21 } = {}) {
  const timeMin = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();

  let items;
  try {
    const url = `${CAL}?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
      `&singleEvents=true&orderBy=startTime&maxResults=250`;
    ({ items = [] } = await api(env, url));
  } catch (err) {
    await markSource(sql, 'gcal', false, err.message);
    did.push(`Google Calendar FAILED — ${err.message}`);
    return { ok: false, reason: err.message };
  }

  let added = 0, updated = 0;
  const seen = new Set();
  for (const ev of items) {
    if (ev.status === 'cancelled') continue;
    const start = isoOf(ev);
    if (!start) continue;
    seen.add(ev.id);

    const end = endOf(ev);
    const allDay = isAllDay(ev);
    const title = String(ev.summary ?? 'Untitled').trim();

    const [existing] = await sql`
      select id from events where source = 'gcal' and source_id = ${ev.id} limit 1`;

    if (existing) {
      await sql`
        update events set title = ${title}, start_at = ${start}, end_at = ${end},
               all_day = ${allDay},
               location = ${ev.location ?? null}, url = ${ev.htmlLink ?? null},
               conferencing_url = ${ev.hangoutLink ?? null}, deleted_at = null
         where id = ${existing.id}`;
      updated++;
    } else {
      await sql`
        insert into events (title, start_at, end_at, all_day, location, source, source_id, url, conferencing_url, seen_in)
        values (${title}, ${start}, ${end}, ${allDay}, ${ev.location ?? null}, 'gcal', ${ev.id},
                ${ev.htmlLink ?? null}, ${ev.hangoutLink ?? null}, ${['gcal']})`;
      added++;
    }
  }

  /**
   * Events Google no longer has.
   *
   * Without this, deleting something in Google left the row here alive
   * forever. Four phantom rows for one errand outlived the Google events
   * they came from, and the agent — reading this table, not Google — went on
   * reporting that errand as on the calendar twice. A calendar that
   * cannot forget is not a calendar.
   *
   * This query was answered for exactly this window, so anything inside it
   * that Google did not return is genuinely gone. Rows outside the window are
   * untouched: Google was never asked about them.
   */
  // An empty read is far more likely to be a bad response than a genuinely
  // empty three weeks, and retiring on it would clear the whole calendar.
  const retired = seen.size
    ? await sql`
        update events set deleted_at = now()
         where source = 'gcal' and deleted_at is null
           and start_at >= ${timeMin} and start_at <= ${timeMax}
           and not (source_id = any(${[...seen]}))
         returning id`
    : [];

  await markSource(sql, 'gcal', true);
  if (added) did.push(`Google Calendar: ${added} new event${added === 1 ? '' : 's'}`);
  if (updated) did.push(`Google Calendar: ${updated} event${updated === 1 ? '' : 's'} refreshed`);
  if (retired.length) {
    did.push(`Google Calendar: ${retired.length} event${retired.length === 1 ? '' : 's'} no longer there — removed`);
  }

  return { ok: true, read: items.length, added, updated, retired: retired.length };
}

/**
 * Copy Outlook-only events into Google (spec §1a, Tier 1 — silent, logged).
 *
 * Only future events, only ones never mirrored before. The mirrored_at guard
 * matters: mirroring runs before reconciliation pairs the two copies, so
 * without it a second pass would duplicate everything.
 */
/**
 * Remove a mirror this console put in Google.
 *
 * Only ever called with an id the console itself recorded in
 * `mirror_gcal_id`, so it can only unpick its own work — never an event the owner
 * created. A 404 or 410 means Google has already lost it, which is the
 * outcome we wanted.
 */
export async function deleteMirror(env, gcalId) {
  try {
    await api(env, `${CAL}/${encodeURIComponent(gcalId)}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    if (/\b(404|410)\b/.test(String(err.message))) return true;
    throw err;
  }
}

export async function mirrorOutlookToGoogle(sql, env, did, { limit = 40 } = {}) {
  const rows = await sql`
    select id, title, start_at, end_at, location
      from events
     where source = 'outlook' and deleted_at is null
       and mirrored_at is null
       and seen_in = ${['outlook']}
       and start_at > now()
     order by start_at
     limit ${limit}`;

  if (!rows.length) return { ok: true, mirrored: 0 };

  let mirrored = 0;
  const failures = [];

  for (const ev of rows) {
    try {
      /**
       * Claim the row before writing to Google, not after.
       *
       * This creates events in your real calendar, so the ordering matters more
       * here than anywhere else in the worker. Writing first and recording
       * second leaves a window in which a second pass — or the same pass after
       * a failed database write — sees the row still unclaimed and creates the
       * event again. That window was not theoretical: it once put two events
       * on the calendar three times each.
       *
       * The claim is conditional on `mirrored_at is null`, so of two racing
       * passes exactly one gets the row and the other skips it.
       */
      const claim = await sql`
        update events set mirrored_at = now()
         where id = ${ev.id} and mirrored_at is null
         returning id`;
      if (!claim.length) continue;

      /**
       * Belt and braces: ask Google whether it already has this one.
       *
       * The claim protects against two passes racing. This protects against
       * everything else — a database restored from backup, a row cleared by
       * hand, a crash between the POST and the claim. Google is the system of
       * record for what is on your calendar, so it is the thing worth asking.
       */
      let gcalId = null;
      try {
        const found = await api(
          env,
          `${CAL}?privateExtendedProperty=${encodeURIComponent(`cos_event=${ev.id}`)}&maxResults=5`,
        );
        gcalId = (found.items ?? []).find((i) => i.status !== 'cancelled')?.id ?? null;
      } catch { /* if the lookup fails, fall through and create */ }

      if (!gcalId) {
        const created = await api(env, CAL, {
          method: 'POST',
          body: JSON.stringify({
            summary: ev.title,
            location: ev.location ?? undefined,
            start: { dateTime: new Date(ev.start_at).toISOString() },
            end: { dateTime: new Date(ev.end_at ?? new Date(Date.parse(ev.start_at) + 3600_000)).toISOString() },
            description: `Mirrored from HBS Outlook by ${PROFILE.appName}.`,
            extendedProperties: { private: { cos_source: 'outlook', cos_event: String(ev.id) } },
          }),
        });
        gcalId = created.id;
        mirrored++;
      }

      await sql`
        update events set mirror_gcal_id = ${gcalId}, seen_in = ${['outlook', 'gcal']}
         where id = ${ev.id}`;
    } catch (err) {
      // The claim stands only if the event actually reached Google. Releasing
      // it lets the next pass retry; keeping it would silently drop the event.
      try {
        await sql`update events set mirrored_at = null
                   where id = ${ev.id} and mirror_gcal_id is null`;
      } catch { /* the database is what failed — leave it claimed, not duplicated */ }
      failures.push(`${ev.title.slice(0, 30)}: ${String(err.message).slice(0, 80)}`);
      if (failures.length >= 3) break; // stop hammering a broken endpoint
    }
  }

  if (mirrored) did.push(`Mirrored ${mirrored} Outlook event${mirrored === 1 ? '' : 's'} into Google Calendar`);
  for (const f of failures) did.push(`Mirror FAILED — ${f}`);

  return { ok: failures.length === 0, mirrored, failed: failures.length };
}

/**
 * Events you have registered for on 12Twenty, put on your actual calendar.
 *
 * Registering on 12Twenty does nothing to Google or Outlook — 12Twenty keeps
 * its own list and that is the end of it. So nine signed-up events existed
 * only inside this console and nowhere you would look on a Tuesday morning.
 *
 * The reverse matters as much: if you cancel on 12Twenty, the sync sets
 * `registered` back to false and the copy here is removed. A calendar that
 * only ever adds is how the duplicate mess started.
 *
 * Claim-before-write and the Google-side lookup are the same as the Outlook
 * mirror above, and for the same reason: this writes to a real calendar.
 */
export async function mirrorRegisteredEvents(sql, env, did, { limit = 25 } = {}) {
  let added = 0, removed = 0;
  const failures = [];

  /* ---- registered, and not yet on the calendar ---- */
  const toAdd = await sql`
    select id, title, start_at, end_at, location, url
      from events
     where source = '12twenty' and registered and deleted_at is null
       and mirror_gcal_id is null and mirrored_at is null
       and start_at > now()
     order by start_at
     limit ${limit}`;

  for (const ev of toAdd) {
    try {
      const claim = await sql`
        update events set mirrored_at = now()
         where id = ${ev.id} and mirrored_at is null
         returning id`;
      if (!claim.length) continue;

      let gcalId = null;
      try {
        const found = await api(
          env,
          `${CAL}?privateExtendedProperty=${encodeURIComponent(`cos_event=${ev.id}`)}&maxResults=5`,
        );
        gcalId = (found.items ?? []).find((i) => i.status !== 'cancelled')?.id ?? null;
      } catch { /* fall through and create */ }

      if (!gcalId) {
        const created = await api(env, CAL, {
          method: 'POST',
          body: JSON.stringify({
            summary: ev.title,
            location: ev.location ?? undefined,
            start: { dateTime: new Date(ev.start_at).toISOString() },
            end: {
              dateTime: new Date(ev.end_at ?? Date.parse(ev.start_at) + 3600_000).toISOString(),
            },
            description: ev.url
              ? `You are registered for this on 12Twenty.\n${ev.url}`
              : 'You are registered for this on 12Twenty.',
            extendedProperties: { private: { cos_source: '12twenty', cos_event: String(ev.id) } },
          }),
        });
        gcalId = created.id;
        added++;
      }

      await sql`update events set mirror_gcal_id = ${gcalId} where id = ${ev.id}`;
    } catch (err) {
      try {
        await sql`update events set mirrored_at = null
                   where id = ${ev.id} and mirror_gcal_id is null`;
      } catch { /* the database is what failed; leave it claimed, not duplicated */ }
      failures.push(`${ev.title.slice(0, 30)}: ${String(err.message).slice(0, 80)}`);
      if (failures.length >= 3) break;
    }
  }

  /* ---- no longer registered: take it back off ---- */
  const toRemove = await sql`
    select id, title, mirror_gcal_id from events
     where source = '12twenty' and not registered
       and mirror_gcal_id is not null and deleted_at is null`;

  for (const ev of toRemove) {
    try {
      await deleteMirror(env, ev.mirror_gcal_id);
      await sql`update events set mirror_gcal_id = null, mirrored_at = null where id = ${ev.id}`;
      removed++;
    } catch (err) {
      failures.push(`removing ${ev.title.slice(0, 30)}: ${String(err.message).slice(0, 60)}`);
    }
  }

  if (added) did.push(`Added ${added} registered 12Twenty event${added === 1 ? '' : 's'} to your calendar`);
  if (removed) did.push(`Removed ${removed} event${removed === 1 ? '' : 's'} you are no longer registered for`);
  for (const f of failures) did.push(`Calendar mirror FAILED — ${f}`);

  return { ok: failures.length === 0, added, removed, failed: failures.length };
}
