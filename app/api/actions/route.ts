import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Queue an action for the laptop worker.
 *
 * Deliberately not a general "create any action, pre-approved" endpoint. The
 * action queue is the mechanism by which things happen on the owner's behalf —
 * calendar writes, event registrations — and every one of those reaches it
 * through a path that shows them what it will do first. A route that accepted
 * any type with status 'approved' would be a way around that, and it would be
 * the kind of hole nobody notices until it matters.
 *
 * So two types are allowed, and both do the same harmless thing: open a
 * sign-in window on the laptop — 12Twenty's, or Google's consent screen. They
 * act on nothing and decide nothing. The owner signs in themselves, and no
 * credential of theirs passes through this application at any point.
 */
const ALLOWED = new Set(['twelvetwenty_login', 'google_auth']);

export async function POST(req: Request) {
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let type: string | undefined;
  let summary: string | undefined;
  try {
    ({ type, summary } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  if (!type || !ALLOWED.has(type)) {
    return NextResponse.json(
      { error: `This endpoint only queues: ${[...ALLOWED].join(', ')}` },
      { status: 400 },
    );
  }

  /**
   * One at a time. Clicking the button twice should not open two browser
   * windows competing for the same Chrome profile — a profile can only carry
   * one live instance, and the second would fail in a way that looks like the
   * sign-in itself failing.
   */
  const existing = (await sql`
    select id from actions
     where type = ${type} and status in ('pending', 'approved', 'executing')
     limit 1`) as unknown as { id: string }[];

  if (existing.length) {
    return NextResponse.json({ ok: true, queued: false, reason: 'already queued' });
  }

  /**
   * Thirty minutes, because a stale one should not surprise anyone.
   *
   * `expires_at` has no default — the insert failed outright the first time
   * this was run, which is the right way for a required column to behave. If
   * the button is pressed with the laptop shut, a window appearing an hour
   * later when the lid opens is startling and useless; by then it would be
   * pressed again anyway.
   */
  const rows = (await sql`
    insert into actions (type, summary, status, expires_at)
    values (${type}, ${summary ?? 'Open a sign-in window on the laptop'}, 'approved',
            now() + interval '30 minutes')
    returning id`) as unknown as { id: string }[];

  return NextResponse.json({ ok: true, queued: true, id: rows[0]?.id });
}
