import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Update what the OWNER has decided about a role.
 *
 * Only four fields are writable here, and all four are the owner's: status,
 * the date applied, their notes, and whether it is starred. The role's own facts —
 * company, deadline, pay, link — are not editable through this route, because
 * they come from the watchlist import or a job board and anything typed over
 * them would be silently undone by the next refresh.
 */
const MINE = new Set(['my_status', 'applied_on', 'my_notes', 'starred']);

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const fields = Object.keys(body).filter((k) => MINE.has(k));
  if (!fields.length) {
    return NextResponse.json(
      { error: `nothing to update; writable fields are ${[...MINE].join(', ')}` },
      { status: 400 },
    );
  }

  /**
   * One statement per field rather than a built-up SET clause.
   *
   * This driver takes tagged templates only — a string assembled from column
   * names and values would be both un-parameterised and, with user input in
   * it, the classic way to open an injection hole. Four small updates cost
   * nothing and cannot be got wrong.
   */
  for (const f of fields) {
    // Empty string means "cleared", which for a date column must be null.
    const raw = body[f];
    const value = raw === '' ? null : raw;

    if (f === 'my_status') await sql`update tracked_roles set my_status = ${value}, updated_at = now() where id = ${id}`;
    if (f === 'applied_on') await sql`update tracked_roles set applied_on = ${value}, updated_at = now() where id = ${id}`;
    if (f === 'my_notes') await sql`update tracked_roles set my_notes = ${value}, updated_at = now() where id = ${id}`;
    if (f === 'starred') await sql`update tracked_roles set starred = ${Boolean(value)}, updated_at = now() where id = ${id}`;
  }

  return NextResponse.json({ ok: true, updated: fields });
}

/** Remove a role the owner added by hand. Watchlist roles stay; they come from the file. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  const rows = (await sql`
    delete from tracked_roles
     where id = ${id} and origin in ('board', 'manual')
     returning id`) as unknown as { id: string }[];

  if (!rows.length) {
    return NextResponse.json(
      { error: 'Not found, or it came from the curated watchlist and cannot be deleted here.' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
