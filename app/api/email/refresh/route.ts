import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask the laptop to re-read the mailbox now.
 *
 * The mail reader drives a signed-in browser, so it only exists on the
 * owner's machine — the website cannot do this itself, only ask. The request becomes
 * an approved action, which the worker's action loop picks up within a minute.
 *
 * This matters because mail cleared in Outlook would otherwise have to be
 * cleared again here, which nobody wants to do twice. Waiting twenty minutes for the next
 * scheduled pass is the difference between the panel being current and being
 * an argument.
 *
 * One pending request at a time. Pressing the button three times should not
 * queue three browser passes.
 */
export async function POST() {
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  const existing = (await sql`
    select id from actions
     where type = 'refresh_mail' and status in ('approved', 'executing')
     limit 1`) as unknown as { id: string }[];

  if (existing[0]) {
    return NextResponse.json({ ok: true, already: true });
  }

  await sql`
    insert into actions (type, status, summary, detail, payload, confidence, expires_at)
    values ('refresh_mail', 'approved',
            'Re-read the HBS mailbox',
            'Asked for from the console. The laptop re-reads the inbox and every folder.',
            '{}'::jsonb, 1, now() + interval '1 hour')`;

  return NextResponse.json({ ok: true });
}
