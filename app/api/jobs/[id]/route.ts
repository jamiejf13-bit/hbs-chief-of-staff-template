import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the owner decided about one posting.
 *
 *   dismissed — not for them. The row is kept so a re-sync cannot resurrect it.
 *   applied   — they have applied. Also kept, and for a better reason: it is the
 *               only record that they did.
 *
 * An empty body still means dismiss, because that is what this route did
 * before the Applied button existed and the dismiss call does not send one.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let action = 'dismissed';
  try {
    const body = await req.json();
    if (body?.action) action = String(body.action);
  } catch {
    /* no body: the original dismiss call, kept working */
  }

  if (action === 'applied') {
    const rows = (await sql`
      update job_postings
         set applied = true, applied_at = now()
       where id = ${id}
       returning company, title`) as unknown as { company: string; title: string }[];
    if (!rows.length) return NextResponse.json({ error: 'No such posting.' }, { status: 404 });
    return NextResponse.json({ ok: true, action, role: `${rows[0].title} — ${rows[0].company}` });
  }

  if (action === 'dismissed') {
    await sql`update job_postings set dismissed = true where id = ${id}`;
    return NextResponse.json({ ok: true, action });
  }

  // Undo, because marking the wrong row applied should not be permanent.
  if (action === 'reopen') {
    await sql`update job_postings
                 set applied = false, applied_at = null, dismissed = false
               where id = ${id}`;
    return NextResponse.json({ ok: true, action });
  }

  return NextResponse.json({ error: 'action must be applied, dismissed or reopen' }, { status: 400 });
}
