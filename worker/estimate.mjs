// How long each task actually takes.
//
// 3 of 105 open tasks carried an estimate. Canvas does not supply duration, so
// nothing populated it, and that one empty column is what blocks the thing
// that matters most: helping optimize the calendar, so that things left out
// for lack of time can fit. You cannot reconcile work against free time
// without knowing how much work there is. A panel built on this column today
// would compute against nulls and cheerfully report you were free.
//
// So: one model call, over every unestimated task at once. Not one call per
// task — 105 requests to fill in a number would be absurd, and batching also
// lets the model see a whole week of HBS work and keep the estimates
// proportionate to each other rather than guessing each in isolation.
//
// Two rules this must never break:
//
//   1. An estimate you set yourself is yours. This only ever fills nulls.
//   2. An estimate is a guess, and is recorded as one. `est_source` says
//      whether a number came from a model or from you, so the UI can show the
//      difference and you can tell when to argue with it.

import Anthropic from '@anthropic-ai/sdk';
import { markSource, log } from './lib.mjs';

const MODEL = 'claude-opus-5';

/** Nothing in an RC day is a two-minute job or a nine-hour one. */
const FLOOR = 5;
const CEILING = 300;

const SYSTEM = `You estimate how long each task will take a first-year Harvard MBA student, in minutes.

Context you can rely on:
- HBS case prep is the bulk of their work. A full case read plus the assignment questions is typically 75-120 minutes. A short case or a reading-only class is 40-60.
- "Class N: <case name>" tasks are case prep.
- Watching a posted video or lecture is usually 15-45 minutes.
- Administrative tasks — registering for an event, submitting a form, replying to an email, uploading a document — are 5-15 minutes.
- Recruiting tasks vary: a coffee chat is 30, tailoring a resume or cover letter is 45-90, a written application is 60-120.
- A task whose title says it is a quiz, poll or survey is 5-15.

Return ONLY a JSON array, no prose and no code fence. One object per task you were given:

  [{"i": 0, "minutes": 90, "why": "full case plus three questions"}]

Rules:
- "i" is the index you were given. Do not renumber, skip or reorder.
- "minutes" is an integer between ${FLOOR} and ${CEILING}.
- "why" is at most eight words, in plain language, naming what drives the length.
- Estimate the WORK, not the elapsed time. A task due in a week that takes 30 minutes is 30.
- If a task is genuinely unclear, estimate anyway and say so in "why". A rough number beats a null.`;

/**
 * Ask for one batch of estimates.
 *
 * Title, course and the first part of the prompt. The full prompt is not sent:
 * an HBS assignment question runs to thousands of characters, 105 of them would
 * dwarf everything else in the request, and the first few hundred already say
 * whether this is a full case or a reading.
 */
export async function estimate(tasks, apiKey) {
  if (!tasks.length) return [];
  const client = new Anthropic({ apiKey });

  const list = tasks
    .map((t, i) => {
      const bits = [`${i}. course=${t.course ?? '-'} title="${t.title}"`];
      if (t.prompt) bits.push(`   question: ${t.prompt.replace(/\s+/g, ' ').slice(0, 300)}`);
      else if (t.notes) bits.push(`   notes: ${t.notes.replace(/\s+/g, ' ').slice(0, 200)}`);
      if (t.has_writeup) bits.push('   (a prep write-up already exists for this class)');
      return bits.join('\n');
    })
    .join('\n');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: list }],
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const json = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Estimator did not return JSON: ${text.slice(0, 140)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Estimator did not return an array');

  // Clamp rather than trust. A model that returns 0 or 4000 should not be able
  // to write a number into the column the calendar maths will read.
  return parsed
    .filter((r) => typeof r.i === 'number' && Number.isFinite(Number(r.minutes)))
    .map((r) => ({
      index: r.i,
      minutes: Math.min(CEILING, Math.max(FLOOR, Math.round(Number(r.minutes)))),
      why: String(r.why ?? '').slice(0, 60),
    }));
}

/**
 * Fill in the estimates that are missing, and only those.
 *
 * Runs rarely: once there is a number on a task it is never asked about again,
 * so this costs one request when a batch of new assignments lands and nothing
 * at all on the passes in between.
 */
export async function syncEstimates(sql, env, did, { limit = 60 } = {}) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const why = 'No ANTHROPIC_API_KEY in .env.local — task durations cannot be estimated';
    await markSource(sql, 'estimates', false, why);
    return { ok: false, reason: why };
  }

  const todo = await sql`
    select t.id, t.title, t.course, t.prompt, t.notes,
           (t.writeup is not null) as has_writeup
      from tasks t
     where t.est_minutes is null
       and t.done = false
       and t.deleted_at is null
     order by t.due_at nulls last
     limit ${limit}`;

  if (!todo.length) {
    await markSource(sql, 'estimates', true, null);
    return { ok: true, estimated: 0, remaining: 0 };
  }

  let results;
  try {
    results = await estimate(todo, apiKey);
  } catch (err) {
    await markSource(sql, 'estimates', false, err.message);
    did.push(`Estimates FAILED — ${err.message}`);
    return { ok: false, reason: err.message };
  }

  let written = 0;
  for (const r of results) {
    const t = todo[r.index];
    if (!t) continue;
    // `est_minutes is null` in the WHERE is not redundant: you may have typed a
    // number into this task while the request was in flight, and yours wins.
    const done = await sql`
      update tasks
         set est_minutes = ${r.minutes},
             est_source = 'model',
             est_why = ${r.why},
             updated_at = now()
       where id = ${t.id} and est_minutes is null
       returning id`;
    if (done.length) written++;
  }

  const left = await sql`
    select count(*) n from tasks
     where est_minutes is null and done = false and deleted_at is null`;

  await markSource(sql, 'estimates', true, null);
  if (written) did.push(`Estimated how long ${written} task${written === 1 ? '' : 's'} will take`);
  log(`estimates: ${written} written, ${left[0].n} still without one`);

  return { ok: true, estimated: written, remaining: Number(left[0].n) };
}
