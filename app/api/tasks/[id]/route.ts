import { NextResponse } from 'next/server';
import { db, hasDb } from '@/lib/db';
import { readFields } from '@/lib/task-fields';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Edit one task.
 *
 * **Mirrored tasks are editable here, deliberately, but only in the fields
 * the source does not own.** Canvas owns a task's title, due date and links;
 * the owner decides how it is filed and how urgent it is. Re-categorising a
 * Canvas assignment as `social` must survive the next sync, so category,
 * course, priority, sort order and done-ness are the owner's on every row —
 * while title and due date stay the source's on mirrored rows.
 *
 * This is the `origin` rule from the spec applied field by field rather than
 * row by row, which is what makes "the coffee chats are social" possible
 * without forking the task away from Canvas.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

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

  const existing = (await sql`
    select id, origin from tasks where id = ${id} and deleted_at is null limit 1`
  ) as unknown as { id: string; origin: string }[];
  if (!existing[0]) return NextResponse.json({ error: 'No such task.' }, { status: 404 });
  const mirrored = existing[0].origin === 'mirrored';

  const parsed = readFields(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const f = parsed.value;

  // Only touch what was actually sent. A missing key means "leave it alone",
  // which is different from an explicit null meaning "clear it".
  const has = (k: string) => k in body;

  if (has('category')) await sql`update tasks set category = ${f.category} where id = ${id}`;
  if (has('course')) await sql`update tasks set course = ${f.course} where id = ${id}`;
  if (has('priority')) await sql`update tasks set priority = ${f.priority} where id = ${id}`;
  if (has('est_minutes')) await sql`update tasks set est_minutes = ${f.est_minutes} where id = ${id}`;

  if (has('sort_order')) {
    const so = body.sort_order === null ? null : Number(body.sort_order);
    if (so !== null && !Number.isFinite(so)) {
      return NextResponse.json({ error: 'sort_order must be a number or null.' }, { status: 400 });
    }
    await sql`update tasks set sort_order = ${so} where id = ${id}`;
  }

  /**
   * What the owner plans to say in class. Editable on a mirrored row like
   * category is, because Canvas owns the question and the owner owns the
   * answer. Stored with a timestamp so the page can say when it was last touched — a prepared
   * response from three weeks ago is not the same as one from last night.
   */
  if (has('response')) {
    const raw = body.response == null ? '' : String(body.response);
    if (raw.length > 20_000) {
      return NextResponse.json({ error: 'That response is too long to store.' }, { status: 400 });
    }
    const text = raw.trim() || null;
    await sql`update tasks set response = ${text},
                               response_at = ${text ? new Date().toISOString() : null}
               where id = ${id}`;
  }

  if (has('done')) {
    const done = body.done === true;
    await sql`update tasks set done = ${done}, done_at = ${done ? new Date().toISOString() : null}
               where id = ${id}`;
  }

  // Canvas owns these on a mirrored row; rewriting them would be undone on the
  // next sync and would quietly disagree with Canvas in the meantime.
  if (has('title') || has('due_at')) {
    if (mirrored) {
      return NextResponse.json({
        ok: true,
        warning: 'Title and deadline belong to Canvas on this task, so they were left alone. Everything else saved.',
      });
    }
    if (has('title')) {
      const title = String(body.title ?? '').trim();
      if (!title) return NextResponse.json({ error: 'A task needs a title.' }, { status: 400 });
      await sql`update tasks set title = ${title} where id = ${id}`;
    }
    if (has('due_at')) await sql`update tasks set due_at = ${f.due_at} where id = ${id}`;
  }

  return NextResponse.json({ ok: true });
}

/** Soft delete, and only for tasks the owner created. A mirrored row would come back. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!hasDb()) return NextResponse.json({ error: 'No database.' }, { status: 409 });
  const sql = db();
  if (!sql) return NextResponse.json({ error: 'No database.' }, { status: 500 });

  const rows = (await sql`
    update tasks set deleted_at = now()
     where id = ${id} and origin = 'owned' and deleted_at is null
     returning id`) as unknown as { id: string }[];

  if (!rows[0]) {
    return NextResponse.json(
      { error: 'Only tasks you created can be deleted. A Canvas one would return on the next sync — tick it off instead.' },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
