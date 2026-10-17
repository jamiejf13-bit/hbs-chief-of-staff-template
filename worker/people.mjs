// Real people from 12Twenty's networking directory.
//
// The "contacts to reach out to" should be interesting people from the
// networking part of 12Twenty.
//
// /mentorships/search rather than /students, and the distinction is the whole
// point: everyone listed there has opted in to being contacted. A cold message
// to someone from the general directory is an intrusion; a message to someone
// who joined the mentorship programme is the thing they signed up for.
//
// The page shape was read before any of this was written — see
// worker/.sessions/people-probe.json. Each person is a `.tt-card` holding
// exactly six lines, in this order:
//
//   Pat Example | Example Robotics | Strategy & Operations Associate |
//   Los Angeles - CA | Full-Time MBA | Spring 2026
//
//   name | employer | job title | location | program | graduation term
//
// Two parsers in this project were written by inferring a page's shape and both
// got it wrong, which is why the probe exists and why this reads by position
// only after checking the card really has six lines.

import { chromium } from 'playwright';
import { PROFILE, BASE, clearStaleLocks, launchOptions, reauthenticate } from './twelvetwenty-login.mjs';
import { TARGETS, has as hasTerm } from './targets.mjs';
import { markSource, log } from './lib.mjs';
import { twelveTwentyBusy } from './lib.mjs';
import { loadSignals, learnedAdjustment } from './learn.mjs';

const SEARCH = `${BASE}/mentorships/search`;

// '(?!)' never matches: an empty list in lib/targets.json must exclude no one,
// not — as an empty alternation would — everyone.
const OFF_TARGET = new RegExp(`\\b(${TARGETS.exclude.employers.join('|') || '(?!)'})(?!\\w)`, 'i');

/**
 * Sectors you are not recruiting into (exclude.sectors in lib/targets.json).
 *
 * The first run put strategy roles at hospitals, pharma and biotech at the top
 * of the list, because a function match alone was enough to surface someone and
 * "Director, Corporate Development" is the right function anywhere.
 *
 * This is a blunt instrument and only catches the sectors that say so in their
 * own name — which is exactly why the learned signal below exists.
 */
const OFF_SECTOR = new RegExp(`\\b(${TARGETS.exclude.sectors.join('|') || '(?!)'})(?!\\w)`, 'i');

/**
 * Score a person, which is NOT the same question as scoring a job.
 *
 * `scoreRole` in targets.mjs gates on the title containing "intern" — correct
 * for a posting you might apply to, and wrong for every human being, whose
 * title is "Strategy & Operations Associate". Run against people it would
 * reject all of them as "not an internship".
 *
 * What makes someone worth talking to is that they already do the work you
 * want to do, at a company you would want to do it at. So: function first,
 * industry second, city as a tie-break, and nothing surfaces on location alone
 * — the same lesson the job scorer learned when awarding location points
 * unconditionally filled the list with Tax Operations roles in the right city.
 */
export function scorePerson({ employer = '', title = '', location = '' }, signals = null) {
  const reasons = [];
  const t = `${title} ${employer}`.toLowerCase();
  const loc = (location ?? '').toLowerCase();

  if (OFF_TARGET.test(employer)) {
    return { score: -10, reasons: [`${employer} is not a target`] };
  }

  const sector = OFF_SECTOR.exec(`${employer} ${title}`);
  if (sector) {
    return { score: -10, reasons: [`${sector[1]} is not a sector you are recruiting into`] };
  }

  /**
   * The same excluded terms the job scorer uses.
   *
   * This was missing, and an employer whose own name carried an excluded
   * term reached the top ten. The list also rules out engineering and
   * data-science roles, which is right here too: a networking list should
   * hold people doing the work you want to move into.
   */
  const banned = hasTerm(`${employer} ${title}`.toLowerCase(), TARGETS.exclude.terms);
  if (banned) return { score: -10, reasons: [`Not a target: ${banned}`] };

  let score = 0;

  const fnIndex = TARGETS.functions.findIndex((f) => hasTerm(t, f.terms));
  if (fnIndex >= 0) {
    score += 5 - fnIndex;
    reasons.push(TARGETS.functions[fnIndex].name);
  }

  const industry = TARGETS.industries.find((i) => hasTerm(t, i.terms));
  if (industry) {
    score += 2;
    reasons.push(industry.name);
  }

  // Doing neither your function nor your industry is not someone to cold-message,
  // however convenient their city.
  if (fnIndex < 0 && !industry) return { score: -5, reasons: ['Different field'] };

  if (hasTerm(loc, TARGETS.locations.primary)) { score += 2; reasons.push(location); }
  else if (hasTerm(loc, TARGETS.locations.secondary)) { score += 1; reasons.push(location); }

  /**
   * What your own decisions have taught, applied last and capped.
   *
   * Last, so it tilts an order the rules have already established rather than
   * replacing it; capped, so no amount of clicking can promote someone who
   * does not do the work you want. The reason is carried onto the row — you
   * should be able to see that a person is down-ranked because you passed on
   * three like them, and disagree with it.
   */
  const learned = learnedAdjustment(signals, { employer, title });
  if (learned.delta) {
    score += learned.delta;
    reasons.push(learned.reason);
  }

  return { score, reasons };
}

/** 'Spring 2026' -> 2026, for telling a current student from an alum. */
function gradYear(term) {
  const m = /(20\d\d)/.exec(term ?? '');
  return m ? Number(m[1]) : null;
}

export async function syncPeople(sql, env, did, { pages = 2, keep = 25 } = {}) {
  // Stand down while a sign-in window is open — the profile holds one browser.
  if (await twelveTwentyBusy(sql)) {
    return { ok: true, skipped: true, reason: 'a 12Twenty sign-in window is open' };
  }

  clearStaleLocks();

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, launchOptions({ headless: true }));
  } catch (err) {
    await markSource(sql, 'people', false, err.message);
    return { ok: false, reason: err.message };
  }

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);

    if (/\/login/i.test(page.url())) {
      // The twelve-hour expiry, renewed the same way the events reader does.
      if (!(await reauthenticate(page))) {
        const why = '12Twenty needs a real sign-in — run "node worker/twelvetwenty-login.mjs"';
        await markSource(sql, 'people', false, why);
        did.push(`People FAILED — ${why}`);
        return { ok: false, reason: why };
      }
      await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(6000);
    }

    await page
      .waitForFunction(() => document.querySelectorAll('.tt-card').length > 3, { timeout: 30_000 })
      .catch(() => { /* an empty directory is a real answer */ });

    const signals = await loadSignals(sql);

    const seen = [];
    for (let p = 0; p < pages; p++) {
      if (p > 0) {
        // Paging is a click, not a URL — the list is an Angular view and the
        // address does not change. Stop quietly when there is no next page.
        const next = page.locator('a[aria-label*="Next"], button[aria-label*="Next"], .pagination a:has-text("›")').first();
        if (!(await next.count().catch(() => 0))) break;
        await next.click().catch(() => {});
        await page.waitForTimeout(5000);
      }

      const batch = await page.evaluate(() =>
        [...document.querySelectorAll('.tt-card')]
          .map((card) => ({
            lines: (card.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
            href: card.querySelector('a[href]')?.getAttribute('href') ?? null,
          }))
          .filter((c) => c.lines.length >= 6));

      if (!batch.length) break;
      seen.push(...batch);
    }

    let kept = 0, skipped = 0;
    const rows = [];

    for (const card of seen) {
      const [name, employer, title, location, program, term] = card.lines;

      // A card whose first line is a filter heading is the search panel, not a
      // person. Cheap to check, and it is the sort of thing that otherwise
      // becomes a contact called "Search Filters".
      if (/^(search filters|graduation term|networking|students)/i.test(name)) continue;

      const { score, reasons } = scorePerson({ employer, title, location }, signals);
      if (score <= 0) { skipped++; continue; }

      rows.push({
        source_id: `${name}|${employer}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 180),
        name, employer, title, location, program,
        grad_year: gradYear(term),
        score,
        reasons,
        url: card.href ? new URL(card.href, BASE).href : SEARCH,
      });
    }

    rows.sort((a, b) => b.score - a.score);

    for (const r of rows.slice(0, keep)) {
      // Upsert: the directory is re-read on a schedule and a person whose title
      // changed should update, not duplicate. `dismissed` is the owner's and is never
      // written here — the whole point of marking someone handled is that they
      // stay handled.
      await sql`
        insert into people (source, source_id, name, employer, title, location,
                            program, grad_year, score, reasons, url)
        values ('12twenty', ${r.source_id}, ${r.name}, ${r.employer}, ${r.title},
                ${r.location}, ${r.program}, ${r.grad_year}, ${r.score},
                ${r.reasons}, ${r.url})
        on conflict (source, source_id) do update
           set name = excluded.name, employer = excluded.employer,
               title = excluded.title, location = excluded.location,
               program = excluded.program, grad_year = excluded.grad_year,
               score = excluded.score, reasons = excluded.reasons,
               url = excluded.url, updated_at = now()`;
      kept++;
    }

    await markSource(sql, 'people', true, null);
    if (kept) did.push(`12Twenty networking: ${kept} people worth contacting`);
    log(`people: ${seen.length} read, ${kept} kept, ${skipped} off-target`);

    return { ok: true, read: seen.length, kept, skipped };
  } catch (err) {
    await markSource(sql, 'people', false, err.message);
    did.push(`People FAILED — ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    await ctx.close();
  }
}
