import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who the owner has spoken to at a company.
 *
 * Recorded against the company, not a specific posting: a coffee chat with
 * someone at a company is worth seeing on every role there being tracked —
 * the question is "who have I spoken to at the company".
 *
 * Deliberately free text. A fixed list of conversation types would be wrong
 * within a week — "met at the company panel", "intro'd by a classmate", "replied to
 * my note" are all the same kind of fact and none of them fits a dropdown.
 */
export async function POST(req: Request) {
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 });
  }

  const company = String(body.company ?? '').trim();
  const name = String(body.name ?? '').trim();
  if (!company || !name) {
    return NextResponse.json({ error: 'company and name are required' }, { status: 400 });
  }

  const rows = (await sql`
    insert into role_contacts (company, name, title, how, spoke_on, notes)
    values (${company}, ${name},
            ${body.title ? String(body.title) : null},
            ${body.how ? String(body.how) : null},
            ${body.spoke_on ? String(body.spoke_on) : null},
            ${body.notes ? String(body.notes) : null})
    returning id, company, name, title, how, spoke_on, notes`) as unknown as Record<string, unknown>[];

  return NextResponse.json({ ok: true, contact: rows[0] });
}

export async function DELETE(req: Request) {
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  await sql`delete from role_contacts where id = ${id}`;
  return NextResponse.json({ ok: true });
}
