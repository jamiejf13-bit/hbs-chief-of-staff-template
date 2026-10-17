import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resolve one queued action.
 *
 * The API never executes anything — it only records the owner's decision. The
 * worker polls for `approved` rows and carries them out on the laptop, which
 * is the only machine that can reach Outlook.
 *
 * `decision`:
 *   approve  — do the thing the card describes
 *   skip     — do nothing, stop asking
 *   remove   — the "cancelled, take it out of Google" answer to a
 *              mirror_to_outlook card. Rewrites the row as the opposite
 *              action rather than inventing a second card for the same event.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  if (!hasDb()) {
    return NextResponse.json({ error: 'No database configured — this is sample data.' }, { status: 409 });
  }
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let decision = '';
  let note: string | null = null;
  try {
    const body = await req.json();
    decision = String(body?.decision ?? '');
    // Optional. Trimmed to something a calendar body can carry without the
    // entry becoming unreadable in Outlook's preview pane.
    if (body?.note != null) {
      const t = String(body.note).trim();
      note = t ? t.slice(0, 500) : null;
    }
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  if (!['approve', 'skip', 'remove'].includes(decision)) {
    return NextResponse.json({ error: `Unknown decision "${decision}".` }, { status: 400 });
  }

  type ActionRow = { id: string; type: string; status: string; payload: unknown };
  const rows = (await sql`
    select id, type, status, payload from actions where id = ${id} limit 1`) as unknown as ActionRow[];
  const action = rows[0];
  if (!action) return NextResponse.json({ error: 'No such action.' }, { status: 404 });

  // Only a pending action can be decided. Anything else means it was already
  // resolved, or the worker is mid-flight with it.
  if (action.status !== 'pending') {
    return NextResponse.json(
      { error: `That action is already "${action.status}".`, status: action.status },
      { status: 409 },
    );
  }

  // Recorded whichever way the answer goes — a note on a skip is often the more
  // useful one, because it says why the thing was not worth doing.
  if (note !== null) await sql`update actions set note = ${note} where id = ${id}`;

  if (decision === 'skip') {
    await sql`update actions set status = 'skipped', resolved_at = now() where id = ${id}`;
    return NextResponse.json({ ok: true, status: 'skipped' });
  }

  if (decision === 'remove') {
    if (action.type !== 'mirror_to_outlook') {
      return NextResponse.json({ error: 'That answer only applies to a calendar mismatch.' }, { status: 400 });
    }
    await sql`
      update actions
         set type = 'remove_stale_event', status = 'approved',
             summary = 'Remove from Google — you confirmed it was cancelled'
       where id = ${id}`;
    return NextResponse.json({ ok: true, status: 'approved', type: 'remove_stale_event' });
  }

  await sql`update actions set status = 'approved' where id = ${id}`;
  return NextResponse.json({ ok: true, status: 'approved' });
}
