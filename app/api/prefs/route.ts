import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Small, durable UI decisions.
 *
 * These live in Postgres rather than the browser because the decision and its
 * consequence happen on different devices: Tuesday's prep dismissed on the
 * laptop on Sunday evening must not be offered again on the phone on
 * Monday morning.
 *
 * Currently one field. Kept deliberately narrow — an endpoint that accepts an
 * arbitrary settings blob is an endpoint nobody can reason about later.
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

  if (!('get_ahead_dismissed_for' in body)) {
    return NextResponse.json({ error: 'Nothing to set.' }, { status: 400 });
  }

  const raw = body.get_ahead_dismissed_for;

  // null clears the dismissal. Anything else must be a plain calendar date —
  // this value is compared as a string in the UI, so a loose parse here would
  // surface as an offer that silently never reappears.
  if (raw !== null && !(typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw))) {
    return NextResponse.json({ error: 'Expected null or a YYYY-MM-DD date.' }, { status: 400 });
  }

  const value = raw as string | null;
  await sql`
    update prefs
       set get_ahead_dismissed_for = ${value}::date, updated_at = now()
     where id = true`;

  return NextResponse.json({ ok: true, get_ahead_dismissed_for: value });
}
