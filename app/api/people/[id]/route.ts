import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Three things the owner can say about a person, and what each one teaches.
 *
 *   not_interested  down — the words of this employer and title get a penalty
 *   to_contact      up   — worth reaching out to, not yet done
 *   contacted       up   — reached out; the strongest signal there is
 *
 * The row is updated in place rather than deleted, so a re-sync of the
 * directory cannot resurrect someone already ruled on — the same reason
 * a dismissed job posting is kept.
 */
const DECISIONS = {
  not_interested: 'down',
  to_contact: 'up',
  contacted: 'up',
} as const;

type Status = keyof typeof DECISIONS;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let status: string | undefined;
  try {
    ({ status } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  if (!status || !(status in DECISIONS)) {
    return NextResponse.json(
      { error: `status must be one of ${Object.keys(DECISIONS).join(', ')}` },
      { status: 400 },
    );
  }

  const rows = (await sql`
    update people
       set status = ${status},
           status_at = now(),
           dismissed = ${status === 'not_interested'},
           contacted_at = case when ${status} = 'contacted' then now() else contacted_at end,
           updated_at = now()
     where id = ${id}
     returning employer, title`) as unknown as { employer: string | null; title: string | null }[];

  if (!rows.length) return NextResponse.json({ error: 'No such person.' }, { status: 404 });

  // Nothing else to do. The scorer derives what it has learned from these
  // rows directly on its next pass, so writing the status IS teaching it —
  // there is no second place for the lesson to fail to arrive.
  return NextResponse.json({ ok: true, status });
}
