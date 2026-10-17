// Canvas → tasks.
//
// Canvas is the one source with a real API and a personal access token, so it
// needs no browser and can run unattended. It is also the largest single win:
// 240 assignments across seven courses, every one carrying a due date.
//
// Everything written here is origin 'mirrored'. You may tick a mirrored task
// off — that is local and never submitted back — but title and due date belong
// to Canvas and are overwritten on every sync. Nothing is ever written TO
// Canvas. Read-only, always (spec §11).

import { markSource } from './lib.mjs';
import { PROFILE, CANVAS_COURSE_CODES } from './profile.mjs';

/**
 * Canvas course_code → short code, from lib/profile.json.
 * Anything not listed (e.g. RCHQ, RC Headquarters) is administrative, not a class.
 */
const COURSE_CODES = CANVAS_COURSE_CODES;

/**
 * Assignments older than this are history, not a queue.
 *
 * One day, not seven. Canvas has no idea which cases you have actually
 * prepared — there is nothing to mark them done, and nothing is ever written
 * back. A seven-day window therefore filled Today with last week's classes,
 * every one scored as overdue and pinned above the work that matters.
 * A case whose class has already met is not actionable; it is history.
 */
const LOOKBACK_DAYS = 1;
/** Beyond this, a deadline is not yet actionable and only clutters Week. */
const LOOKAHEAD_DAYS = 45;

/** Fallback when the weights table has no lead time for a course. */
const DEFAULT_LEAD_DAYS = 1;

function api(env) {
  const base = env.CANVAS_BASE_URL || PROFILE.canvas?.baseUrl || 'https://hbs.instructure.com';
  const headers = { Authorization: `Bearer ${env.CANVAS_TOKEN}` };
  return async function get(path) {
    const res = await fetch(`${base}${path}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText} on ${path}${body ? ` — ${body.slice(0, 120)}` : ''}`);
    }
    return res.json();
  };
}

function classify(courseCode) {
  const mapped = COURSE_CODES[courseCode];
  if (mapped) return { category: 'class', course: mapped };
  return { category: 'admin', course: null }; // RCHQ and anything unrecognised
}

/**
 * Pull the links out of an assignment description.
 *
 * This is the difference between a to-do that says "read the FRC case" and one
 * that opens it. HBS puts the coursepack link, the Harvard Online content and
 * any attached slides straight into the description.
 */
function extractLinks(html) {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const re = /<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);

    const label = m[2]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    out.push({ href, label: label.slice(0, 120) || hostOf(href), kind: kindOf(href) });
  }
  // Cases first — that is what gets opened before class.
  const rank = { case: 0, 'canvas-file': 1, 'harvard-online': 2, other: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 12);
}

function kindOf(href) {
  if (/hbsp\.harvard\.edu/i.test(href)) return 'case';
  if (/instructure\.com\/courses\/\d+\/files\//i.test(href)) return 'canvas-file';
  if (/harvardonline\.harvard\.edu/i.test(href)) return 'harvard-online';
  return 'other';
}

function hostOf(href) {
  try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return 'link'; }
}

/**
 * The assignment description as written, not as a one-line preview.
 *
 * `plain()` below collapses all whitespace, which is right for a list row and
 * wrong for the thing you actually want to read: HBS puts the preparation
 * questions in the description, numbered, and a numbered list flattened into
 * one paragraph stops being a set of questions.
 *
 * Ordered lists keep real numbers so that "question 2" means something.
 */
function readable(html) {
  if (!html) return null;

  let s = String(html);

  // Number the items of each ordered list before the tags are stripped.
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return inner.replace(/<li\b[^>]*>/gi, () => `\n${++n}. `);
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|ul|ol|blockquote|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;|&lsquo;/g, '’')
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    // A list item whose text sits inside its own <p> leaves the bullet or the
    // number stranded on a line by itself. Rejoin it with what it labels.
    .replace(/(^|\n)(•|\d+\.)[ \t]*\n+[ \t]*/g, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Long enough for a full case prep sheet; short enough not to bloat state.
  return s ? s.slice(0, 12_000) : null;
}

/** Strip Canvas's HTML description down to something readable in a list. */
function plain(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 500) : null;
}

export async function syncCanvas(sql, env, did) {
  if (!env.CANVAS_TOKEN || env.CANVAS_TOKEN === 'PASTE_TOKEN_HERE') {
    await markSource(sql, 'canvas', false, 'CANVAS_TOKEN not set');
    return { ok: false, reason: 'no token' };
  }

  const get = api(env);
  const now = Date.now();
  const from = now - LOOKBACK_DAYS * 86_400_000;
  const to = now + LOOKAHEAD_DAYS * 86_400_000;

  // Lead times drive work_opens_at, which is what keeps Today honest:
  // a task due Friday should not shout on Monday.
  const [w] = await sql`select lead_days from weights where id = true`;
  const leadDays = w?.lead_days ?? {};

  let courses;
  try {
    courses = await get('/api/v1/courses?enrollment_state=active&per_page=50');
  } catch (err) {
    await markSource(sql, 'canvas', false, err.message);
    return { ok: false, reason: err.message };
  }

  const seen = new Set();
  let added = 0, updated = 0, skipped = 0;
  const failures = [];

  for (const course of courses) {
    const { category, course: courseKey } = classify(course.course_code);
    const lead = leadDays[courseKey ?? 'admin'] ?? DEFAULT_LEAD_DAYS;

    let items;
    try {
      items = await get(`/api/v1/courses/${course.id}/assignments?per_page=100`);
    } catch (err) {
      failures.push(`${course.course_code}: ${err.message}`);
      continue;
    }

    for (const a of items) {
      if (!a.due_at) { skipped++; continue; }
      const due = Date.parse(a.due_at);
      if (!Number.isFinite(due) || due < from || due > to) { skipped++; continue; }

      const sourceId = `${course.id}/assignments/${a.id}`;
      seen.add(sourceId);

      const opensAt = new Date(due - lead * 86_400_000).toISOString();
      const title = String(a.name ?? 'Untitled assignment').trim();

      const [existing] = await sql`
        select id, done from tasks where source = 'canvas' and source_id = ${sourceId} limit 1`;

      const links = JSON.stringify(extractLinks(a.description));

      if (existing) {
        // Never touch done/done_at — ticking off is the owner's, not Canvas's.
        // Never touch response/response_at either: what you plan to say is
        // yours, and a sync that erased it would be unforgivable.
        await sql`
          update tasks
             set title = ${title}, notes = ${plain(a.description)},
                 prompt = ${readable(a.description)},
                 category = ${category}, course = ${courseKey},
                 due_at = ${a.due_at}, work_opens_at = ${opensAt},
                 url = ${a.html_url ?? null}, links = ${links}::jsonb,
                 deleted_at = null
           where id = ${existing.id}`;
        updated++;
      } else {
        await sql`
          insert into tasks (title, notes, prompt, origin, source, source_id, category, course,
                             due_at, work_opens_at, url, links)
          values (${title}, ${plain(a.description)}, ${readable(a.description)},
                  'mirrored', 'canvas', ${sourceId},
                  ${category}, ${courseKey}, ${a.due_at}, ${opensAt},
                  ${a.html_url ?? null}, ${links}::jsonb)`;
        added++;
      }
    }
  }

  // Soft-delete mirrored rows Canvas no longer returns in the window.
  // Soft, because a flaky sync must never destroy history (spec §3).
  const retired = seen.size
    ? await sql`
        update tasks set deleted_at = now()
         where source = 'canvas' and deleted_at is null
           and not (source_id = any(${[...seen]}))
        returning id`
    : [];

  if (failures.length) {
    await markSource(sql, 'canvas', false, failures.join(' | '));
  } else {
    await markSource(sql, 'canvas', true);
  }

  if (added) did.push(`Canvas: ${added} new assignment${added === 1 ? '' : 's'} added to the queue`);
  if (updated) did.push(`Canvas: ${updated} assignment${updated === 1 ? '' : 's'} refreshed`);
  if (retired.length) did.push(`Canvas: ${retired.length} assignment${retired.length === 1 ? '' : 's'} no longer listed, retired`);
  for (const f of failures) did.push(`Canvas FAILED — ${f}`);

  return { ok: failures.length === 0, added, updated, retired: retired.length, skipped, courses: courses.length };
}
