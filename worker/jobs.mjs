// Job postings straight from company career sites.
//
// Most companies run their careers page on a hosted applicant-tracking system
// with a documented public JSON endpoint — the same data the page itself
// fetches. Reading that is not scraping: no browser, no session, no
// impersonation, and it survives a redesign that would break a DOM parser.
//
// Which is also why LinkedIn is absent here. LinkedIn has no such endpoint and
// its terms forbid the alternative, so LinkedIn roles arrive only through the
// alert emails it sends you (worker/gmail.mjs). The rail shows both together.
//
// Verified against the live boards in Sep 2026: Lyft 178 postings,
// Instacart 110, Stripe 671, Anthropic 617, OpenAI 816, Ramp 150.

import { markSource } from './lib.mjs';
import { scoreRole, TARGETS } from './targets.mjs';

/**
 * The boards to watch live in lib/targets.json under "job_boards" — an
 * example set there; replace it with the companies you are targeting.
 *
 * Add a company by finding its careers page and seeing which system it runs
 * on (Greenhouse or Ashby) — the URL usually says. `slug` is the name in that
 * URL. Check the slug against the live endpoint before adding it: a board that
 * answers 404 costs a request and returns nothing, and a board invented from a
 * company name is worse — it looks like coverage and is not.
 *
 * Some large employers run their own systems with no public endpoint, so they
 * are not readable this way. Their roles still reach you through LinkedIn
 * alert emails and 12Twenty.
 */
const BOARDS = TARGETS.job_boards ?? [];

/**
 * Scoring lives in worker/targets.mjs, against lib/targets.json.
 *
 * It used to be three copies of the same word lists in three files, which is
 * how a role ruled out as a target survived here after it was removed
 * elsewhere, and how remote postings kept scoring a bonus after remote had
 * been switched off as a target.
 */
const assess = (title, location) => scoreRole(title, location);

async function readGreenhouse(slug) {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`greenhouse ${slug}: HTTP ${res.status}`);
  const { jobs = [] } = await res.json();
  return jobs.map((j) => ({
    source_id: String(j.id),
    title: j.title ?? '',
    location: j.location?.name ?? null,
    url: j.absolute_url ?? '',
    posted_at: j.updated_at ? new Date(j.updated_at).toISOString() : null,
  }));
}

async function readAshby(slug) {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ashby ${slug}: HTTP ${res.status}`);
  const { jobs = [] } = await res.json();
  return jobs.map((j) => ({
    source_id: String(j.id ?? j.jobId ?? j.title),
    title: j.title ?? '',
    location: j.location ?? null,
    url: j.jobUrl ?? j.applyUrl ?? '',
    posted_at: j.publishedAt ? new Date(j.publishedAt).toISOString() : null,
  }));
}

export async function syncJobBoards(sql, env, did, { minScore = 5 } = {}) {
  let added = 0, seen = 0;
  const failures = [];

  /**
   * When this sweep began, and which boards actually answered.
   *
   * Both are needed to tell a closed posting from a board that timed out. A
   * row is expired only when its own board responded and did not list it;
   * expiring on absence alone would quietly close every role at a company
   * whose API was briefly down, and you would never know the difference.
   */
  /**
   * The sweep's start time, read from the DATABASE's clock.
   *
   * It used to be `new Date()`, from the laptop. last_seen_at is written with
   * Postgres `now()`, so the expiry test compared two clocks a second or so
   * apart and every row written during the sweep looked older than the sweep
   * itself — which expired live postings the moment they were seen. The
   * single best match, at a score of 9, was marked closed while sitting on
   * the board.
   */
  const [{ now: sweptAt }] = await sql`select now()`;
  const answered = [];

  for (const board of BOARDS) {
    let postings;
    try {
      postings = board.kind === 'ashby'
        ? await readAshby(board.slug)
        : await readGreenhouse(board.slug);
    } catch (err) {
      // One broken board must not take the others down with it.
      failures.push(`${board.company}: ${String(err.message).slice(0, 60)}`);
      continue;
    }
    answered.push(board.slug);

    for (const p of postings) {
      seen++;
      if (!p.title || !p.url) continue;
      const { score, reasons } = assess(p.title, p.location);
      if (score < minScore) continue;

      const res = await sql`
        insert into job_postings (source, source_id, company, title, location, url,
                                  posted_at, reasons, score, last_seen_at)
        values (${board.kind}, ${`${board.slug}:${p.source_id}`}, ${board.company},
                ${p.title}, ${p.location}, ${p.url}, ${p.posted_at}, ${reasons}, ${score}, now())
        on conflict (source, source_id) do update
          set score = excluded.score, reasons = excluded.reasons, title = excluded.title,
              last_seen_at = now(),
              -- Back on the board after being closed: reopened, or the board
              -- hiccupped last time. Either way it is live now.
              expired_at = null
        returning (xmax = 0) as inserted`;
      if (res[0]?.inserted) added++;
    }
  }

  /**
   * Rescore what is already stored, and drop what no longer qualifies.
   *
   * The loop above skips a low score before it reaches the upsert, so a row
   * stored under an older, looser rule kept that score for ever — tightening
   * the scoring changed nothing for anything already in the table. Twelve
   * Tax Operations and Accounting roles sat at 7 after the rule that put
   * them there had been removed.
   *
   * Cheap: this is tens of rows, not thousands, because the thousands were
   * rejected before they ever got here.
   */
  /**
   * What the answering boards stopped listing.
   *
   * Scoped two ways, both deliberate. Only boards in `answered`, so a failed
   * fetch cannot close a company's roles. And only rows last seen before this
   * sweep started, so a posting read thirty seconds ago is never caught by the
   * same pass that read it.
   *
   * Expired rather than deleted: you may have applied to it, and a role that
   * closed is worth seeing at the bottom of the list rather than vanishing as
   * though it never existed.
   */
  let expired = 0;
  for (const slug of answered) {
    const gone = await sql`
      update job_postings
         set expired_at = now()
       where source_id like ${slug + ':%'}
         and expired_at is null
         and (last_seen_at is null or last_seen_at < ${sweptAt})
       returning id`;
    expired += gone.length;
  }
  if (expired) {
    did.push(`Job boards: ${expired} role${expired === 1 ? ' is' : 's are'} no longer listed`);
  }

  let rescored = 0, dropped = 0;
  for (const row of await sql`select id, title, location, score from job_postings`) {
    const { score, reasons } = assess(row.title, row.location);
    if (score < minScore) {
      await sql`delete from job_postings where id = ${row.id}`;
      dropped++;
    } else if (score !== row.score) {
      await sql`update job_postings set score = ${score}, reasons = ${reasons} where id = ${row.id}`;
      rescored++;
    }
  }
  if (dropped) did.push(`Job boards: ${dropped} role${dropped === 1 ? '' : 's'} no longer match and were dropped`);

  const ok = failures.length < BOARDS.length;
  await markSource(sql, 'jobs', ok, failures.join('; ') || null).catch(() => {});

  if (added) did.push(`Job boards: ${added} new role${added === 1 ? '' : 's'} worth a look`);
  for (const f of failures) did.push(`Job board unreadable — ${f}`);

  return { ok, boards: BOARDS.length, seen, added, rescored, dropped, failed: failures.length };
}
