import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Clear one mail item, in one of two different senses.
 *
 * This touches nothing in Gmail or Outlook. The mail itself stays exactly as
 * it is — unread if it was unread, wherever it was filed. All this records is
 * what should happen in the console, which is a fact about the console and
 * not about the mailbox.
 *
 * `{ reason: 'not_relevant' }` means "stop showing me this KIND of thing".
 * Anything else means "I dealt with this one". They are kept apart because
 * only the first is worth learning from: treating every finished email as a
 * signal about relevance would teach the wrong lesson from ordinary work.
 *
 * The row is kept rather than deleted, so a re-sync cannot resurrect it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  // A body is optional: the plain POST that the Dismiss button has always
  // sent still means "handled", and must keep working.
  let reason = 'handled';
  try {
    const body = await req.json();
    if (body && typeof body.reason === 'string') reason = body.reason;
  } catch { /* no body — the old shape */ }

  if (reason === 'not_relevant') {
    const rows = (await sql`
      update email_items
         set not_relevant = true, not_relevant_at = now(),
             handled = true, handled_at = now()
       where id = ${id}
       returning id, from_name, from_email, subject`) as unknown as
      { id: string; from_name: string | null; from_email: string | null; subject: string }[];

    if (!rows[0]) return NextResponse.json({ error: 'No such message.' }, { status: 404 });
    // The sender and subject are already on the row, which is what a later
    // pass will learn from. Nothing more needs recording here.
    return NextResponse.json({ ok: true, not_relevant: true });
  }

  const rows = (await sql`
    update email_items set handled = true, handled_at = now()
     where id = ${id} and not handled
     returning id`) as unknown as { id: string }[];

  if (!rows[0]) return NextResponse.json({ ok: true, already: true });
  return NextResponse.json({ ok: true });
}
