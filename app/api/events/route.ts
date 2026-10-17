import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';
import { readEventFields } from '@/lib/event-fields';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create a calendar event from the console.
 *
 * **Nothing here touches Google or Outlook.** Neither set of credentials
 * exists on Vercel — that is the whole point of the hybrid design — so this
 * writes the event locally, marks it `pending`, and queues the work for the
 * laptop, which owns both calendars.
 *
 * The event is real in the console immediately. It reaches Google and Outlook
 * when the worker next runs. The UI shows which of those two states it is in;
 * silently implying the calendars had been updated would be the one
 * unacceptable outcome.
 */
export async function POST(req: Request) {
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

  const parsed = readEventFields(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const f = parsed.value;

  if (!f.title) return NextResponse.json({ error: 'An event needs a title.' }, { status: 400 });
  if (!f.start_at) return NextResponse.json({ error: 'An event needs a start time.' }, { status: 400 });

  // Default to an hour. A zero-length block is invisible on the grid.
  const end = f.end_at ?? new Date(Date.parse(f.start_at) + 3600_000).toISOString();

  const rows = (await sql`
    insert into events (title, start_at, end_at, location, source, origin,
                        sync_state, task_id, seen_in)
    values (${f.title}, ${f.start_at}, ${end}, ${f.location}, 'gcal', 'owned',
            'pending', ${f.task_id}, ${['console']})
    returning id`) as unknown as { id: string }[];

  const id = rows[0].id;

  await sql`
    insert into actions (type, status, summary, detail, payload, confidence, expires_at)
    values ('create_calendar_event', 'approved',
            ${`Add "${f.title}" to both calendars`},
            'Created in the console. The laptop writes it to Google and Outlook.',
            ${JSON.stringify({ event_id: id })}::jsonb,
            1, now() + interval '7 days')`;

  return NextResponse.json({ ok: true, id, sync_state: 'pending' });
}
