import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';
import { readFields } from '@/lib/task-fields';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create a task the owner owns.
 *
 * `origin` is always 'owned' and `source` always 'manual'. Nothing created
 * here may ever look mirrored: the schema constraint ties `origin='mirrored'`
 * to a non-null `source_id`, and a hand-made task has no source to be
 * overwritten from. Sync must never touch these rows.
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

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return NextResponse.json({ error: 'A task needs a title.' }, { status: 400 });
  if (title.length > 500) return NextResponse.json({ error: 'That title is too long.' }, { status: 400 });

  const parsed = readFields(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { category, course, due_at, priority, est_minutes } = parsed.value;

  /**
   * A link back to whatever prompted the task.
   *
   * A to-do made from an email is useless without it: "Reply to Pat about
   * the trek" means hunting through the mailbox for the thread that was open
   * when the button was pressed. Optional, and only accepted as an
   * http(s) URL so a task cannot carry a javascript: link to be clicked later.
   */
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl.slice(0, 1000) : null;

  const rows = await sql`
    insert into tasks (title, origin, source, category, course, due_at, priority, est_minutes, url)
    values (${title}, 'owned', 'manual', ${category ?? 'personal'}, ${course},
            ${due_at}, ${priority}, ${est_minutes}, ${url})
    returning id`;

  return NextResponse.json({ ok: true, id: (rows as unknown as { id: string }[])[0].id });
}
