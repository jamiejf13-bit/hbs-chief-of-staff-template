import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';
import { readEventFields } from '@/lib/event-fields';
import { isTimetabled } from '@/lib/timetable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = {
  id: string; title: string; start_at: string; end_at: string | null;
  origin: string; source: string; source_id: string | null; match_key: string | null;
  all_day: boolean;
};

/**
 * Move, resize or retitle an event.
 *
 * Applies locally and queues the calendars, same as create. Two things are
 * deliberately harder than they look:
 *
 * **A reconciled event is two rows.** Moving the Outlook row must move the
 * Google one too, or the next reconciliation will see them at different times
 * and ask the owner to resolve a conflict they just caused themselves. So the local
 * write applies to every row sharing the `match_key`.
 *
 * **A class is not the owner's to move.** Course events come from the HBS timetable;
 * dragging MKT to Thursday would be mirrored out to both calendars and would
 * simply be wrong. Those are refused with a reason rather than silently
 * ignored.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  if (!hasDb()) {
    return NextResponse.json({ error: 'No database configured — this is sample data.' }, { status: 409 });
  }
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const found = (await sql`
    select id, title, start_at, end_at, origin, source, source_id, match_key, all_day
      from events where id = ${id} and deleted_at is null limit 1`) as unknown as Row[];
  const ev = found[0];
  if (!ev) return NextResponse.json({ error: 'No such event.' }, { status: 404 });

  /**
   * Clearing a recruiting prompt is not a calendar edit.
   *
   * It records that the owner has dealt with it — registered, or decided it is
   * not for them — and nothing goes to Google or Outlook. Handled before anything
   * else, because falling through to the edit path would mark the event
   * pending and queue a calendar write for a decision that never touched the
   * calendar.
   */
  if ('recruiting_cleared' in body) {
    const why = String(body.recruiting_cleared);
    if (!['registered', 'not-relevant', 'register-me'].includes(why)) {
      return NextResponse.json({ error: `Unknown outcome "${why}".` }, { status: 400 });
    }

    /**
     * "Register me" is a request, not a record.
     *
     * The other two say what already happened. This one asks the laptop to go
     * and do it on 12Twenty, so the row is not marked registered until the
     * worker has seen the page say so — claiming it here would be a guess.
     */
    if (why === 'register-me') {
      if (ev.source !== '12twenty') {
        return NextResponse.json(
          { error: 'Registration only works for 12Twenty events.' },
          { status: 409 },
        );
      }
      /**
       * One queued registration per event.
       *
       * The button gave no visible feedback, so it was pressed five times and
       * queued five identical registrations for the same fireside chat. The
       * feedback is fixed too, but the endpoint should not have depended on
       * the button behaving.
       */
      const already = (await sql`
        select id from actions
         where type = 'register_event'
           and status in ('approved', 'executing')
           and payload->>'event_id' = ${id}
         limit 1`) as unknown as { id: string }[];
      if (already.length) {
        return NextResponse.json({ ok: true, queued: true, already: true });
      }

      await sql`
        insert into actions (type, status, summary, detail, payload, confidence, expires_at)
        values ('register_event', 'approved',
                ${`Register for "${ev.title}"`},
                'Asked for from the rail. The laptop opens 12Twenty and completes it.',
                ${JSON.stringify({ event_id: id })}::jsonb,
                1, now() + interval '7 days')`;
      return NextResponse.json({ ok: true, queued: true });
    }

    await sql`
      update events
         set registered = ${why === 'registered'}, recruiting_dismissed = true
       where id = ${id}`;
    return NextResponse.json({ ok: true, cleared: why });
  }

  if (isTimetabled(ev.title)) {
    return NextResponse.json(
      { error: 'That is a scheduled class. Moving it here would push the change to both calendars, and the class would still meet at its real time.' },
      { status: 409 },
    );
  }

  // An all-day event has a day, not a time. Dragging one onto a 15-minute
  // slot would rewrite it as a timed event, which Google refuses and which is
  // not what a birthday is anyway.
  if (ev.all_day && ('start_at' in body || 'end_at' in body)) {
    return NextResponse.json(
      { error: 'That is an all-day event, so it has no time to move. Rename it or delete it instead.' },
      { status: 409 },
    );
  }

  const parsed = readEventFields(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const f = parsed.value;

  const start = 'start_at' in body ? f.start_at : ev.start_at;
  const end = 'end_at' in body ? f.end_at : ev.end_at;
  if (start && end && Date.parse(end) <= Date.parse(start)) {
    return NextResponse.json({ error: 'The end time has to be after the start time.' }, { status: 400 });
  }

  // Every row for this commitment, so the two calendars stay in step.
  const ids = ev.match_key
    ? ((await sql`select id from events where match_key = ${ev.match_key} and deleted_at is null`
      ) as unknown as { id: string }[]).map((r) => r.id)
    : [ev.id];

  for (const rowId of ids) {
    if ('title' in body && f.title) await sql`update events set title = ${f.title} where id = ${rowId}`;
    if ('start_at' in body) await sql`update events set start_at = ${start} where id = ${rowId}`;
    if ('end_at' in body) await sql`update events set end_at = ${end} where id = ${rowId}`;
    if ('location' in body) await sql`update events set location = ${f.location} where id = ${rowId}`;
    if ('task_id' in body) await sql`update events set task_id = ${f.task_id} where id = ${rowId}`;
    await sql`update events set sync_state = 'pending', sync_error = null where id = ${rowId}`;
  }

  /**
   * One pending update per event, not one per drag.
   *
   * Nudging a block across the grid a few times used to queue an action each
   * time, and the worker would then replay every intermediate position before
   * arriving at the final one — slow, and each replay is a real write to a
   * real calendar. Only the last state matters, so earlier queued updates for
   * the same event are retired first.
   *
   * Only rows not yet picked up are touched. An action already 'executing' is
   * mid-flight on the laptop and must be left alone.
   */
  await sql`
    update actions
       set status = 'skipped', resolved_at = now(),
           error = 'Superseded by a later change to the same event'
     where type = 'update_event_time'
       and status = 'approved'
       and payload -> 'event_ids' ?| ${ids}`;

  await sql`
    insert into actions (type, status, summary, detail, payload, confidence, expires_at)
    values ('update_event_time', 'approved',
            ${`Update "${f.title ?? ev.title}" in both calendars`},
            'Changed in the console. The laptop applies it to Google and Outlook.',
            ${JSON.stringify({ event_ids: ids })}::jsonb,
            1, now() + interval '7 days')`;

  return NextResponse.json({ ok: true, updated: ids.length, sync_state: 'pending' });
}

/**
 * Remove an event.
 *
 * Soft delete here, and the Google copy is queued for real deletion on the
 * laptop. The Outlook copy cannot be removed automatically for the same
 * reason it cannot be edited — finding and deleting the wrong item in a real
 * calendar is not a recoverable mistake — so that half is reported.
 *
 * Classes are refused outright. Deleting MKT from the console would not stop
 * the class happening; it would only stop it being seen.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  const found = (await sql`
    select id, title, source, source_id, match_key, origin
      from events where id = ${id} and deleted_at is null limit 1`) as unknown as Row[];
  const ev = found[0];
  if (!ev) return NextResponse.json({ error: 'That event is already gone.' }, { status: 404 });

  if (isTimetabled(ev.title)) {
    return NextResponse.json(
      { error: 'That is a scheduled class. Removing it here would only hide it — the class still meets.' },
      { status: 409 },
    );
  }

  const rows = ev.match_key
    ? ((await sql`select id, source, source_id from events
                   where match_key = ${ev.match_key} and deleted_at is null`
      ) as unknown as { id: string; source: string; source_id: string | null }[])
    : [{ id: ev.id, source: ev.source, source_id: ev.source_id }];

  for (const r of rows) {
    await sql`update events set deleted_at = now() where id = ${r.id}`;
    if (r.source === 'gcal' && r.source_id) {
      await sql`
        insert into actions (type, status, summary, detail, payload, confidence, expires_at)
        values ('remove_stale_event', 'approved',
                ${`Delete "${ev.title}" from Google`},
                'Removed in the console. The laptop deletes it from Google.',
                ${JSON.stringify({ event_id: r.id })}::jsonb,
                1, now() + interval '7 days')`;
    }
  }

  const inOutlook = rows.some((r) => r.source === 'outlook');
  return NextResponse.json({
    ok: true,
    removed: rows.length,
    warning: inOutlook
      ? 'Removed here and queued for Google. Outlook has to be deleted by hand — this console will not delete an Outlook item on its own.'
      : null,
  });
}

