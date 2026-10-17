import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { db, hasDb } from '@/lib/db';
import { getState } from '@/lib/state';
import { readFields } from '@/lib/task-fields';
import { readEventFields } from '@/lib/event-fields';
import { isTimetabled } from '@/lib/timetable';
import { PROFILE, COURSE_CODES } from '@/lib/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MODEL = 'claude-opus-5';

/**
 * The owner's time zone, from lib/profile.json. Stated explicitly because this
 * code runs on Vercel, which is UTC, and every time in the prompt was four
 * hours out — an 8:30am Discussion Group was described to the model as 12:30pm.
 */
const ZONE = PROFILE.timezone || 'America/New_York';

/** Waking hours, from lib/profile.json. Work is never placed outside them. */
const AWAKE_START = PROFILE.awakeHours?.start ?? 7;
const AWAKE_END = PROFILE.awakeHours?.end ?? 23;
const hourLabel = (h: number) => {
  const n = ((h % 24) + 24) % 24;
  if (n === 0) return 'midnight';
  if (n === 12) return 'noon';
  return n < 12 ? `${n}am` : `${n - 12}pm`;
};
const AWAKE_LABEL = `${hourLabel(AWAKE_START)} to ${hourLabel(AWAKE_END)}`;

/** Course codes the tools accept, from lib/profile.json. */
const COURSE_ENUM: string[] = COURSE_CODES.length ? COURSE_CODES : ['OTHER'];

const inZone = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString('en-US', { timeZone: ZONE, ...opts });


/**
 * The chat box.
 *
 * The student types what they want done; Claude either answers or calls one of a
 * small set of tools that write to the same database the rest of the console
 * reads. It is deliberately narrow:
 *
 * - It can **add and amend** tasks and add calendar blocks.
 * - It cannot delete anything, cannot touch a Canvas assignment's title or
 *   deadline, and cannot send email. Those are either the source's to own or
 *   Tier 3 in the spec.
 * - Calendar writes queue for the laptop like every other calendar write, so
 *   nothing here reaches Google or Outlook directly.
 *
 * Every tool call is reported back to the UI, so what it did is visible rather
 * than inferred from the prose.
 */

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_task',
    description:
      'Add a new to-do that the user owns. Use for anything they ask to remember, ' +
      'prepare, or follow up on. Do not use for Canvas assignments — those already exist.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short and concrete, as they would write it.' },
        category: {
          type: 'string',
          enum: ['class', 'recruiting', 'social', 'clubs', 'admin', 'personal'],
          description: 'social = section coffee chats and friends; clubs = club obligations.',
        },
        course: { type: 'string', enum: COURSE_ENUM },
        due_at: { type: 'string', description: 'ISO 8601. Omit if there is no real deadline.' },
        priority: { type: 'integer', enum: [1, 2, 3], description: '1 high, 2 normal, 3 low. Omit unless they signal urgency.' },
        est_minutes: { type: 'integer' },
      },
      required: ['title', 'category'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'update_task',
    description:
      'Change how an existing task is filed or prioritised. Works on Canvas tasks too — ' +
      'category, course and priority are the user\'s. Title and deadline on a Canvas task belong ' +
      'to Canvas and will be refused.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id from the list you were given.' },
        category: { type: 'string', enum: ['class', 'recruiting', 'social', 'clubs', 'admin', 'personal'] },
        course: { type: 'string', enum: COURSE_ENUM },
        priority: { type: 'integer', enum: [1, 2, 3] },
        est_minutes: { type: 'integer' },
        done: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'register_for_event',
    description:
      'Actually register the user for a 12Twenty event. Use when they say "sign me up" — ' +
      'they mean register, not add a to-do. Identify the event by name; you do not need ' +
      'an id and must never ask them for one. The laptop opens 12Twenty and completes the ' +
      'registration; tell them it is queued for the laptop, not that it is done.',
    input_schema: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          description: 'The event as they named it, e.g. "Example Co at HBS". Matched on the title.',
        },
      },
      required: ['event'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'collapse_duplicates',
    description:
      'The same thing is on the calendar more than once under the SAME name. Keeps one and ' +
      'hides the rest. This is the tool for "converge the two dinner reservations" — ' +
      'merge_duplicate_events is only for two entries with DIFFERENT names. Never ask the user ' +
      'which copy to keep: they are identical, so it does not matter.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'The name, or part of it, e.g. "Reservation".' },
        day: { type: 'string', description: 'YYYY-MM-DD, if they named a day.' },
      },
      required: ['event'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'merge_duplicate_events',
    description:
      'Two calendar entries are the same commitment. Hides the duplicate and keeps the other. ' +
      'Use when the user says something is showing twice and the automatic rules missed it — ' +
      'they only catch entries at the same time with similar titles. Identify both by name; ' +
      'you do not need ids and must never ask the user for one. Nothing is deleted from Google or ' +
      'Outlook; the entry stops appearing here.',
    input_schema: {
      type: 'object',
      properties: {
        keep: {
          type: 'string',
          description: 'The entry to keep, as they would say it — a title, or part of one.',
        },
        hide: { type: 'string', description: 'The duplicate to hide, likewise by name.' },
        day: {
          type: 'string',
          description: 'YYYY-MM-DD, when they have named a day. Defaults to searching the visible window.',
        },
      },
      required: ['keep', 'hide'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'add_calendar_block',
    description:
      'Block time on the calendar. Queues for the laptop, which writes it to Google and ' +
      'Outlook — tell them it is queued, not done. Use task_id to say what the time is for.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start_at: { type: 'string', description: 'ISO 8601, local time.' },
        end_at: { type: 'string', description: 'ISO 8601. Defaults to an hour after the start.' },
        location: { type: 'string' },
        task_id: { type: 'string', description: 'The to-do this time is set aside for.' },
      },
      required: ['title', 'start_at'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'move_event',
    description:
      'Change the time of an event that is ALREADY on the user\'s calendar. This is the tool for ' +
      '"move X to 5:30", "push Y back an hour", "make Z 30 minutes longer". Identify it by ' +
      'name; you do not need an id and must never ask the user for one. Both calendar copies move ' +
      'together. The laptop applies it to Google; Outlook has to be changed by hand, so say ' +
      'so when the event came from Outlook. Do NOT use add_calendar_block to fake a move — ' +
      'that leaves the original in place and puts a second entry next to it.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'The event as they named it, e.g. "Pick up dry cleaning".' },
        start_at: { type: 'string', description: 'The new start, ISO 8601 in their local time.' },
        end_at: { type: 'string', description: 'The new end, ISO 8601. Defaults to keeping the current length.' },
        day: { type: 'string', description: 'YYYY-MM-DD, only if needed to tell two copies apart.' },
      },
      required: ['event', 'start_at'],
      additionalProperties: false,
    },
    strict: true,
  },
];

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        error:
          'ANTHROPIC_API_KEY is not set, so the chat cannot run yet. Add it in Vercel ' +
          '(Project → Settings → Environment Variables) and redeploy; for local dev, put it in .env.local.',
      },
      { status: 503 },
    );
  }
  if (!hasDb()) {
    return NextResponse.json({ error: 'No database configured — this is sample data.' }, { status: 409 });
  }

  let turns: Anthropic.MessageParam[];
  try {
    const body = await req.json();
    turns = Array.isArray(body?.messages) ? body.messages : [];
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }
  if (!turns.length) return NextResponse.json({ error: 'Nothing to say.' }, { status: 400 });

  const client = new Anthropic({ apiKey: key });
  const messages: Anthropic.MessageParam[] = [...turns];
  const did: string[] = [];

  /**
   * Built once, not once per pass.
   *
   * This was inside the loop, so every pass re-read the ENTIRE console state
   * from the database to rebuild a system prompt that had not changed. Six
   * passes meant six full state reads on top of six model calls, and a
   * request that queued two calendar blocks took 31 seconds. What the tools
   * did comes back through tool_result blocks, which is how the model learns
   * the state moved — it does not need the whole picture reassembled.
   */
  const system = await buildSystem();

  /**
   * A time budget, because the platform's is fatal.
   *
   * The function is killed at 60 seconds and the browser sees a dropped
   * connection — which the chat could only report as "could not reach the
   * server", on a request that had in fact run, called tools, and changed
   * the calendar before dying. Stopping at 45 leaves room to answer with
   * what was actually done.
   */
  const DEADLINE_MS = 52_000;
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > DEADLINE_MS;

  try {
    // A handful of passes is plenty for "add three things and block an hour".
    // The cap exists so a confused loop cannot run up a bill.
    for (let pass = 0; pass < 6; pass++) {
      if (outOfTime()) {
        return NextResponse.json({
          reply: did.length
            ? 'That was taking a while, so I stopped there. What I did get done is listed below — check it before asking again, so nothing happens twice.'
            : 'That took longer than I am allowed and I stopped before doing anything. Try asking for one thing at a time.',
          did,
        });
      }

      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system,
        tools: TOOLS,
        messages,
      });

      if (res.stop_reason === 'refusal') {
        return NextResponse.json({ error: 'Claude declined that one.', did }, { status: 200 });
      }

      const calls = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (!calls.length) {
        const text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        return NextResponse.json({ reply: text, did });
      }

      messages.push({ role: 'assistant', content: res.content });

      // All results go back in ONE user message, or Claude learns to stop
      // making parallel calls.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        try {
          const note = await runTool(call.name, call.input as Record<string, unknown>);
          did.push(note);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: note });
        } catch (err) {
          const why = err instanceof Error ? err.message : 'That did not work.';
          results.push({ type: 'tool_result', tool_use_id: call.id, content: why, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }

    return NextResponse.json({ reply: 'That took more steps than expected — stopping here.', did });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: 'The Anthropic API key was rejected.' }, { status: 502 });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: 'Rate limited — try again in a moment.' }, { status: 429 });
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `Claude API error ${err.status}.`, did }, { status: 502 });
    }
    return NextResponse.json({ error: 'The chat failed. Nothing was half-applied.', did }, { status: 500 });
  }
}

/**
 * The system prompt carries the owner's actual day, so the model never has to ask a
 * tool for context it could have been handed. Task ids are included because
 * update_task needs them and guessing one would edit the wrong row.
 */
async function buildSystem(): Promise<string> {
  const state = await getState();
  const now = new Date(state.now);

  // A three-day window, not just today. The owner asks about "tonight" at 9pm
  // and about tomorrow's dinner, and an agent that can only see today has to ask.
  const from = Date.now() - 12 * 3600_000;
  const until = Date.now() + 3 * 86_400_000;
  const events = state.events
    .filter((e) => {
      const t = Date.parse(e.start_at);
      return t > from && t < until;
    })
    .map((e) => `  ${hhmm(e.start_at)} ${e.title}${e.location ? ` (${e.location})` : ''}`)
    .join('\n') || '  nothing';

  const tasks = state.tasks
    .filter((t) => !t.done)
    .slice(0, 40)
    .map((t) => `  ${t.id} · ${t.category}${t.course ? `/${t.course}` : ''}` +
      `${t.due_at ? ` · due ${inZone(t.due_at, { weekday: 'short', month: 'short', day: 'numeric' })}` : ''} · ${t.title}`)
    .join('\n');

  return [
    `You help ${PROFILE.name}, an ${PROFILE.program} student (Class of ${PROFILE.classYear}, Section ${PROFILE.section}, ${PROFILE.year} year), run their week.`,
    '',
    `It is ${now.toLocaleString('en-US', { timeZone: ZONE, dateStyle: 'full', timeStyle: 'short' })} in ${PROFILE.city}.`,
    '',
    'Calendar, now to three days out (id · day · time · what):',
    events,
    '',
    'Their open to-dos (id · category/course · due · title):',
    tasks,
    '',
    'How to behave:',
    '- Do what they ask with the tools, then say what you did in one or two short sentences.',
    '- Bullets, no preamble, no restating their request back to them. They read this on a phone.',
    '- If a deadline is vague ("Friday"), resolve it against the date above and say which date you used.',
    '- If something is genuinely ambiguous, do the part that is clear and ask one short question.',
    '- Never invent a task that already exists in the list. Check before adding.',
    '- Calendar blocks queue for their laptop to write to Google and Outlook. Say "queued", never "added to your calendar".',
    '- You cannot delete anything, email anyone, or change a Canvas assignment\'s title or deadline. Say so plainly if asked.',
    '',
    'PLACING WORK ON THE CALENDAR',
    `- They are awake ${AWAKE_LABEL}. Never put work outside that, however free it looks.`,
    '- Prep goes BEFORE the class it is for — the evening before is the norm.',
    '- Do not book over anything already on the calendar, including classes and Discussion Group.',
    '- Case prep is 60–90 minutes; a reading is 30–45. Do not block three hours for one case.',
    '- If there is genuinely no room, say so and name what they would have to move. Do not squeeze work into a gap that is not there.',
  ].join('\n');
}

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  const sql = db();
  if (!sql) throw new Error('No database.');

  if (name === 'add_task') {
    const parsed = readFields(input);
    if ('error' in parsed) throw new Error(parsed.error);
    const f = parsed.value;
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('A task needs a title.');

    await sql`
      insert into tasks (title, origin, source, category, course, due_at, priority, est_minutes)
      values (${title}, 'owned', 'manual', ${f.category ?? 'personal'}, ${f.course},
              ${f.due_at}, ${f.priority}, ${f.est_minutes})`;
    return `Added to-do: ${title}`;
  }

  if (name === 'update_task') {
    const id = String(input.id ?? '');
    const rows = (await sql`
      select id, title, origin from tasks where id = ${id} and deleted_at is null limit 1`
    ) as unknown as { id: string; title: string; origin: string }[];
    if (!rows[0]) throw new Error('No task with that id.');

    const parsed = readFields(input);
    if ('error' in parsed) throw new Error(parsed.error);
    const f = parsed.value;

    if ('category' in input) await sql`update tasks set category = ${f.category} where id = ${id}`;
    if ('course' in input) await sql`update tasks set course = ${f.course} where id = ${id}`;
    if ('priority' in input) await sql`update tasks set priority = ${f.priority} where id = ${id}`;
    if ('est_minutes' in input) await sql`update tasks set est_minutes = ${f.est_minutes} where id = ${id}`;
    if ('done' in input) {
      const done = input.done === true;
      await sql`update tasks set done = ${done}, done_at = ${done ? new Date().toISOString() : null} where id = ${id}`;
    }
    return `Updated: ${rows[0].title}`;
  }

  if (name === 'register_for_event') {
    const wanted = String(input.event ?? '').trim();
    if (!wanted) throw new Error('Which event?');

    const found = (await sql`
      select id, title, url, registered, start_at
        from events
       where source = '12twenty' and deleted_at is null
         and title ilike ${'%' + wanted + '%'}
         and start_at > now()
       order by start_at limit 5`) as unknown as
      { id: string; title: string; url: string | null; registered: boolean; start_at: string }[];

    if (!found.length) throw new Error(`No upcoming 12Twenty event matching "${wanted}".`);
    if (found.length > 1) {
      throw new Error(
        `That matches ${found.length}: ${found.map((f) => f.title).join('; ')}. Ask the user which one, by name.`,
      );
    }

    const ev = found[0];
    if (ev.registered) return `You are already registered for "${ev.title}".`;

    await sql`
      insert into actions (type, status, summary, detail, payload, confidence, expires_at)
      values ('register_event', 'approved',
              ${`Register for "${ev.title}"`},
              'Asked for in the chat box. The laptop opens 12Twenty and completes it.',
              ${JSON.stringify({ event_id: ev.id })}::jsonb,
              1, now() + interval '7 days')`;

    return `Queued registration for "${ev.title}" — the laptop will complete it on 12Twenty`;
  }

  if (name === 'collapse_duplicates') {
    const text = String(input.event ?? '').trim();
    if (!text) throw new Error('Which event?');
    const day = typeof input.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.day)
      ? input.day : null;

    const rows = (await sql`
      select id, title, source, start_at from events
       where deleted_at is null and duplicate_of is null
         and title ilike ${'%' + text + '%'}
         and (${day}::date is null or start_at::date = ${day}::date)
       order by start_at`) as unknown as
      { id: string; title: string; source: string; start_at: string }[];

    if (rows.length < 2) {
      return rows.length === 1
        ? `Only one "${rows[0].title}" — nothing to collapse.`
        : `Nothing matching "${text}".`;
    }

    /**
     * Group by start time, then keep one per group.
     *
     * Two entries at different times are two commitments, however alike the
     * names; two at the same time are one. Outlook wins because the owner
     * maintains it, and the longer title carries more information.
     */
    const groups = new Map<number, typeof rows>();
    for (const r of rows) {
      const slot = Math.round(Date.parse(r.start_at) / (15 * 60_000));
      groups.set(slot, [...(groups.get(slot) ?? []), r]);
    }

    let hidden = 0;
    const kept: string[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const keep = [...group].sort((x, y) =>
        (y.source === 'outlook' ? 1 : 0) - (x.source === 'outlook' ? 1 : 0)
        || y.title.length - x.title.length)[0];
      for (const r of group) {
        if (r.id === keep.id) continue;
        await sql`update events set duplicate_of = ${keep.id} where id = ${r.id}`;
        hidden++;
      }
      kept.push(keep.title);
    }

    if (!hidden) return `Those "${text}" entries are at different times, so they are not duplicates.`;
    return `Collapsed ${hidden + kept.length} entries into ${kept.length}: ${[...new Set(kept)].join(', ')}`;
  }

  if (name === 'merge_duplicate_events') {
    const keepText = String(input.keep ?? '').trim();
    const hideText = String(input.hide ?? '').trim();
    if (!keepText || !hideText) throw new Error('Name both entries.');

    /**
     * Resolved by name, never by id.
     *
     * The first version took ids, and when the model did not have one it asked
     * the user for it — which is meaningless to them and exactly the kind of
     * plumbing they should never see.
     */
    const day = typeof input.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.day)
      ? input.day : null;

    const find = async (text: string) => {
      const rows = (await sql`
        select id, title, start_at from events
         where deleted_at is null and duplicate_of is null
           and title ilike ${'%' + text + '%'}
           and (${day}::date is null or start_at::date = ${day}::date)
         order by start_at limit 4`) as unknown as
        { id: string; title: string; start_at: string }[];
      if (!rows.length) throw new Error(`Nothing matching "${text}".`);
      if (rows.length > 1) {
        // Identical titles are the duplicate case, not an ambiguity to punt
        // back to the user — that dead-ended on two identically titled
        // restaurant reservations.
        const identical = rows.every((r) => r.title === rows[0].title);
        if (identical) return rows[0];
        throw new Error(
          `"${text}" matches ${rows.length}: ${rows.map((r) => r.title).join('; ')}. Ask the user which, by name.`,
        );
      }
      return rows[0];
    };

    const keep = await find(keepText);
    const hide = await find(hideText);
    if (keep.id === hide.id) throw new Error('Those are the same entry.');

    await sql`update events set duplicate_of = ${keep.id} where id = ${hide.id}`;
    return `Merged: hid "${hide.title}", kept "${keep.title}"`;
  }

  if (name === 'add_calendar_block') {
    const parsed = readEventFields(input);
    if ('error' in parsed) throw new Error(parsed.error);
    const f = parsed.value;
    if (!f.title || !f.start_at) throw new Error('A block needs a title and a start time.');

    /**
     * The owner is asleep, whatever the calendar says.
     *
     * Asked to find time for two cases, the agent booked FRC prep at 2:30am —
     * on two separate runs. It was not wrong that the time was free. A
     * constraint this basic cannot live only in the prompt, because a prompt
     * is advice and this is a fact about a person.
     */
    const hour = Number(inZone(f.start_at, { hour: 'numeric', hour12: false }));
    if (hour < AWAKE_START || hour >= AWAKE_END) {
      throw new Error(
        `${hhmm(f.start_at)} is outside waking hours — they are asleep. `
        + `Pick a time between ${hourLabel(AWAKE_START)} and ${hourLabel(AWAKE_END)}, or tell them there is no room.`,
      );
    }
    const end = f.end_at ?? new Date(Date.parse(f.start_at) + 3600_000).toISOString();

    const rows = (await sql`
      insert into events (title, start_at, end_at, location, source, origin, sync_state, task_id, seen_in)
      values (${f.title}, ${f.start_at}, ${end}, ${f.location}, 'gcal', 'owned', 'pending',
              ${f.task_id}, ${['console']})
      returning id`) as unknown as { id: string }[];

    await sql`
      insert into actions (type, status, summary, detail, payload, confidence, expires_at)
      values ('create_calendar_event', 'approved',
              ${`Add "${f.title}" to both calendars`},
              'Asked for in the chat box. The laptop writes it to Google and Outlook.',
              ${JSON.stringify({ event_id: rows[0].id })}::jsonb,
              1, now() + interval '7 days')`;

    return `Queued calendar block: ${f.title} at ${hhmm(f.start_at)}`;
  }

  /**
   * Move something already on the calendar.
   *
   * Without this the agent could only add, so asked to move an errand
   * it correctly answered that it could not — and the only thing it could
   * offer was a new block beside the old one, which is not a move. It takes
   * the same path as dragging the block in the grid: rewrite every row
   * sharing the match_key, then queue one update.
   */
  if (name === 'move_event') {
    const wanted = String(input.event ?? '').trim();
    if (!wanted) throw new Error('Which event?');

    const startAt = String(input.start_at ?? '').trim();
    if (!startAt || Number.isNaN(Date.parse(startAt))) {
      throw new Error('move_event needs a start time it can parse.');
    }

    const day = typeof input.day === 'string' && input.day.trim() ? input.day.trim() : null;

    const found = (await sql`
      select id, title, start_at, end_at, all_day, source, match_key
        from events
       where deleted_at is null and duplicate_of is null
         and title ilike ${'%' + wanted + '%'}
         and start_at > now() - interval '12 hours'
         and (${day}::text is null or (start_at at time zone ${ZONE})::date = ${day}::date)
       order by start_at limit 6`) as unknown as {
        id: string; title: string; start_at: string; end_at: string | null;
        all_day: boolean; source: string; match_key: string | null;
      }[];

    if (!found.length) throw new Error(`Nothing on the calendar matching "${wanted}".`);

    // Two rows for one commitment is normal — Outlook and Google both hold it,
    // and reconciliation pairs them by match_key. That is one event, not two.
    const distinct = new Map<string, typeof found[number]>();
    for (const e of found) {
      const key = e.match_key ?? `${e.title}|${e.start_at}`;
      if (!distinct.has(key)) distinct.set(key, e);
    }
    if (distinct.size > 1) {
      const when = [...distinct.values()]
        .map((e) => `${e.title} at ${hhmm(e.start_at)}`)
        .join('; ');
      throw new Error(`That matches ${distinct.size}: ${when}. Ask the user which one, by time.`);
    }

    const ev = [...distinct.values()][0];
    if (ev.all_day) {
      throw new Error(`"${ev.title}" is an all-day event, so it has no time to move.`);
    }
    if (isTimetabled(ev.title)) {
      throw new Error(
        `"${ev.title}" is a scheduled class — moving it here would change both calendars and the class would still meet at its real time.`,
      );
    }

    // Keep the current length unless an end was given.
    const length = ev.end_at ? Date.parse(ev.end_at) - Date.parse(ev.start_at) : 3600_000;
    const endRaw = typeof input.end_at === 'string' && input.end_at.trim() ? input.end_at.trim() : null;
    const start = new Date(Date.parse(startAt)).toISOString();
    const end = endRaw && !Number.isNaN(Date.parse(endRaw))
      ? new Date(Date.parse(endRaw)).toISOString()
      : new Date(Date.parse(startAt) + Math.max(length, 15 * 60_000)).toISOString();

    if (Date.parse(end) <= Date.parse(start)) {
      throw new Error('The end time has to be after the start time.');
    }

    const ids = ev.match_key
      ? ((await sql`select id from events where match_key = ${ev.match_key} and deleted_at is null`
        ) as unknown as { id: string }[]).map((r) => r.id)
      : [ev.id];

    for (const rowId of ids) {
      await sql`update events set start_at = ${start}, end_at = ${end},
                                  sync_state = 'pending', sync_error = null
                 where id = ${rowId}`;
    }

    // One pending update per event, never one per instruction.
    await sql`
      update actions set status = 'skipped', resolved_at = now(),
             error = 'Superseded by a later change to the same event'
       where type = 'update_event_time' and status = 'approved'
         and payload -> 'event_ids' ?| ${ids}`;

    await sql`
      insert into actions (type, status, summary, detail, payload, confidence, expires_at)
      values ('update_event_time', 'approved',
              ${`Move "${ev.title}" to ${hhmm(start)}`},
              'Asked for in the chat box. The laptop applies it to Google.',
              ${JSON.stringify({ event_ids: ids })}::jsonb,
              1, now() + interval '7 days')`;

    const outlook = ev.source === 'outlook'
      || ((await sql`select 1 from events where id = any(${ids}) and source = 'outlook'`
        ) as unknown as unknown[]).length > 0;

    return `Moving "${ev.title}" to ${hhmm(start)}–${hhmm(end)}; the laptop is applying it to Google now.`
      + (outlook ? ' It came from Outlook, so Outlook itself still needs the same change by hand.' : '');
  }

  throw new Error(`No such tool: ${name}`);
}

/** Same calendar day in the owner's time zone, not on the server. */
function sameDay(iso: string, now: Date) {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: ZONE });
  return day(new Date(iso)) === day(now);
}

function hhmm(iso: string) {
  return inZone(iso, { hour: 'numeric', minute: '2-digit' });
}
