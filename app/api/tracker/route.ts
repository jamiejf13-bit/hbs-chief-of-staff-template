import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Everything the internships tracker renders.
 *
 * One read, two queries: the roles, and every contact recorded. The
 * contacts come back whole rather than per role because they are keyed by
 * company — one conversation at a company belongs on every role there being
 * tracked, and fetching them per card would be twenty-four round trips to
 * assemble a dozen rows.
 */
export async function GET() {
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  try {
    const [roles, contacts] = await Promise.all([
      sql`select id, origin, source_ref, company, role, function, locations,
                 nyc_option, availability, deadline, timing, pay, blurb, link,
                 link_check, keywords_key, priority,
                 my_status, applied_on, my_notes, starred
            from tracked_roles
           order by starred desc, priority nulls last, company`,
      sql`select id, company, name, title, how, spoke_on, notes
            from role_contacts
           order by spoke_on desc nulls last, created_at desc`,
    ]);

    return NextResponse.json({ roles, contacts }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // A tracker that renders empty looks like "you have applied nowhere",
    // which is a worse lie than an error message.
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

/**
 * Add a role to the tracker, from a live board posting or typed by hand.
 *
 * The point of the whole change: a role the job boards find can now reach the
 * list the owner actually works from, which it never could while that list was a
 * file compiled into the site.
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
  const role = String(body.role ?? '').trim();
  if (!company || !role) {
    return NextResponse.json({ error: 'company and role are required' }, { status: 400 });
  }

  const origin = body.jobId ? 'board' : 'manual';
  const sourceRef = body.jobId ? String(body.jobId) : null;

  // Already tracked? Say so rather than adding a second card for one role.
  if (sourceRef) {
    const existing = (await sql`
      select id from tracked_roles
       where origin = ${origin} and source_ref = ${sourceRef} limit 1`) as unknown as { id: string }[];
    if (existing.length) {
      return NextResponse.json({ ok: true, added: false, id: existing[0].id });
    }
  }

  const rows = (await sql`
    insert into tracked_roles (origin, source_ref, company, role, locations,
                               availability, link, priority)
    values (${origin}, ${sourceRef}, ${company}, ${role},
            ${body.locations ? String(body.locations) : null},
            'Open',
            ${body.link ? String(body.link) : null},
            ${body.priority ? String(body.priority) : '3 - Consider'})
    returning id`) as unknown as { id: string }[];

  return NextResponse.json({ ok: true, added: true, id: rows[0]?.id });
}
