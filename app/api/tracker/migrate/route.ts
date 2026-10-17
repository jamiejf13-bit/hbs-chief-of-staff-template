import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Carry existing tracking out of localStorage and into the table.
 *
 * Until now the tracker kept status, date applied and notes in browser
 * storage, keyed by the watchlist id. That data is real — months of where the
 * owner has applied — and it exists only in the browser, so no server-side
 * migration can reach it. The page reads it once on load and posts it here.
 *
 * Runs at most once per browser, and NEVER overwrites. A row that already
 * carries tracking is left alone: if the new tracker has been used on the
 * laptop and someone then opens an old phone browser still holding stale localStorage,
 * the stale copy must not win. Filling blanks is safe; replacing is not.
 */
export async function POST(req: Request) {
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let body: { tracking?: Record<string, { status?: string; applied?: string; notes?: string }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const tracking = body.tracking ?? {};
  let filled = 0;
  let skipped = 0;

  for (const [sourceRef, mine] of Object.entries(tracking)) {
    const status = mine?.status?.trim() || null;
    const applied = mine?.applied?.trim() || null;
    const notes = mine?.notes?.trim() || null;
    if (!status && !applied && !notes) continue;

    const rows = (await sql`
      update tracked_roles
         set my_status  = coalesce(my_status, ${status}),
             applied_on = coalesce(applied_on, ${applied}::date),
             my_notes   = coalesce(my_notes, ${notes}),
             updated_at = now()
       where origin = 'watchlist'
         and source_ref = ${sourceRef}
         -- Only fill blanks. Anything already tracked here is newer than a
         -- browser's leftover copy by definition.
         and (my_status is null and applied_on is null and my_notes is null)
       returning id`) as unknown as { id: string }[];

    if (rows.length) filled++; else skipped++;
  }

  return NextResponse.json({ ok: true, filled, skipped });
}
