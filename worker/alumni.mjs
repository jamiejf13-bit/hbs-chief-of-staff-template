// Three to five HBS alumni a day, at the companies whose jobs you are tracking.
//
// The ask was: search LinkedIn for contacts at the top jobs and pull 3-5
// contacts every day.
//
// Not LinkedIn. Automating your logged-in account is against LinkedIn's user
// agreement, they detect it, and the consequence is a restricted or banned
// account — the one asset in this system that cannot be rebuilt and the one you
// are recruiting with. Making it work would mean deliberately defeating their
// detection.
//
// The outcome is reachable without that, and better. 12Twenty's Students &
// Alumni directory filters by employer, so "who do I know at Stripe" has a real
// answer: an HBS alum, named, with their current title. They are also far more
// likely to reply than a cold LinkedIn contact, which is the point of the
// exercise.
//
// "Top jobs" is read literally: the companies attached to your highest-scoring
// job postings. Those are the roles you are actually tracking, so those are the
// doors worth knocking on.

import { chromium } from 'playwright';
import { PROFILE, BASE, clearStaleLocks, launchOptions, reauthenticate } from './twelvetwenty-login.mjs';
import { scorePerson } from './people.mjs';
import { loadSignals } from './learn.mjs';
import { companyFromEventTitle } from './company.mjs';
import { markSource, log } from './lib.mjs';
import { twelveTwentyBusy } from './lib.mjs';

const DIRECTORY = `${BASE}/students`;

/** How many new people to add in a day, and how many companies to visit. */
const PER_DAY = 5;
const COMPANIES_PER_RUN = 3;

/**
 * Filter the directory to one employer.
 *
 * The Employer control is a button that opens a typeahead, not a URL
 * parameter — checked on the real page rather than assumed, because the first
 * guess was that it would be a base64 queryCriteria like the events list, and
 * it is not. Returns false when the company has no match, which is ordinary:
 * not every employer has an HBS alum.
 */
async function filterByEmployer(page, company) {
  const button = page.locator('button:has-text("Employer")').first();
  if (!(await button.count().catch(() => 0))) return false;

  await button.click().catch(() => {});
  await page.waitForTimeout(2000);

  const box = page.locator('input[placeholder="Employer"]').first();
  if (!(await box.count().catch(() => 0))) return false;

  /**
   * type(), not fill(). This is the whole bug.
   *
   * fill() sets the input's value and fires one input event. The typeahead is
   * AngularJS and listens for real keystrokes, so it never woke up: the filter
   * silently matched nothing and every company came back "no match" while the
   * page itself was perfectly willing. Typing with a delay produces the key
   * events it is waiting for, and the suggestions appear.
   */
  await box.click().catch(() => {});
  await box.type(company, { delay: 150 }).catch(() => {});
  await page.waitForTimeout(5000);

  /**
   * The suggestion is marked up as <strong class="tt-highlight">, the matched
   * substring inside each option, rather than as [role="option"] or a list
   * item — which is why looking for those found nothing even once the
   * typeahead was awake. Clicking the highlight bubbles to the option.
   */
  const option = page
    .locator('.tt-highlight')
    .filter({ hasText: new RegExp(company.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
    .first();

  if (!(await option.count().catch(() => 0))) return false;
  await option.click().catch(() => {});
  await page.waitForTimeout(6000);
  return true;
}

function readCards(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.tt-card')]
      .map((card) => ({
        lines: (card.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        href: card.querySelector('a[href]')?.getAttribute('href') ?? null,
      }))
      .filter((c) => c.lines.length >= 6));
}

export async function syncAlumni(sql, env, did, { perDay = PER_DAY } = {}) {
  // Already met today's quota? Then do not open a browser at all. The ask was
  // three to five a day, not a firehose, and every visit is a visit 12Twenty's
  // bot protection counts.
  const [today] = await sql`
    select count(*) n from people
     where source = '12twenty-alumni'
       and created_at >= date_trunc('day', now() at time zone 'America/New_York')`;
  const room = perDay - Number(today.n);
  if (room <= 0) return { ok: true, added: 0, reason: 'today\'s quota already met' };

  /**
   * Which companies to knock on, in order of how much interest you have shown.
   *
   * Your job postings first — those are literally "my top jobs". But the first
   * run found none: all three postings were dismissed, so that list was empty
   * and nothing happened. Registering for an employer's event is the same
   * signal arriving by a different route, and a stronger one than a job board
   * keyword match: you gave up an evening for it. A company that appears several
   * times in your registered events outranks one that appears once.
   */
  const fromJobs = await sql`
    select j.company, max(j.score) * 10 as weight
      from job_postings j
     where not j.dismissed
     group by j.company`;

  const regs = await sql`
    select title from events
     where source = '12twenty' and registered = true and deleted_at is null`;

  const tally = new Map();
  for (const r of fromJobs) tally.set(r.company, Number(r.weight));
  for (const e of regs) {
    const c = companyFromEventTitle(e.title);
    if (!c) continue;
    tally.set(c, (tally.get(c) ?? 0) + 1);
  }

  // Skip companies where you already have someone — the point is new doors.
  const already = await sql`select lower(employer) e from people where employer is not null`;
  const have = already.map((r) => r.e);

  const companies = [...tally.entries()]
    .filter(([c]) => !have.some((e) => e.includes(c.toLowerCase())))
    .sort((a, b) => b[1] - a[1])
    .slice(0, COMPANIES_PER_RUN)
    .map(([company, weight]) => ({ company, weight }));

  if (!companies.length) {
    await markSource(sql, 'alumni', true, null);
    return { ok: true, added: 0, reason: 'no target company without a contact' };
  }

  // Stand down while a sign-in window is open — the profile holds one browser.
  if (await twelveTwentyBusy(sql)) {
    return { ok: true, skipped: true, reason: 'a 12Twenty sign-in window is open' };
  }

  clearStaleLocks();
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, launchOptions({ headless: true }));
  } catch (err) {
    await markSource(sql, 'alumni', false, err.message);
    return { ok: false, reason: err.message };
  }

  let added = 0;
  const visited = [];

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(DIRECTORY, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);

    if (/\/login/i.test(page.url())) {
      if (!(await reauthenticate(page))) {
        const why = '12Twenty needs a real sign-in — run "node worker/twelvetwenty-login.mjs"';
        await markSource(sql, 'alumni', false, why);
        return { ok: false, reason: why };
      }
      await page.goto(DIRECTORY, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(6000);
    }

    const signals = await loadSignals(sql);

    for (const { company } of companies) {
      if (added >= room) break;

      // Back to a clean directory between companies, so a filter from the last
      // one cannot still be applied to the next.
      await page.goto(DIRECTORY, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(5000);

      const filtered = await filterByEmployer(page, company);
      if (!filtered) { visited.push(`${company}: no match`); continue; }

      const cards = await readCards(page);
      const candidates = [];

      for (const card of cards) {
        const [name, employer, title, location, program, term] = card.lines;
        if (/^(search filters|graduation term|students|networking)/i.test(name)) continue;
        // The filter is a typeahead and can land on a near-miss, so confirm the
        // employer actually matches before trusting the page.
        if (!employer?.toLowerCase().includes(company.toLowerCase().split(/\s+/)[0])) continue;

        const { score, reasons } = scorePerson({ employer, title, location }, signals);
        if (score <= 0) continue;

        candidates.push({
          source_id: `${name}|${employer}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 180),
          name, employer, title, location, program,
          grad_year: Number((/(20\d\d)/.exec(term ?? '') ?? [])[1]) || null,
          score, reasons,
          url: card.href ? new URL(card.href, BASE).href : DIRECTORY,
        });
      }

      candidates.sort((a, b) => b.score - a.score);

      // At most two per company, so five a day is five doors rather than one
      // company's whole alumni list.
      for (const c of candidates.slice(0, 2)) {
        if (added >= room) break;
        const done = await sql`
          insert into people (source, source_id, name, employer, title, location,
                              program, grad_year, score, reasons, url)
          values ('12twenty-alumni', ${c.source_id}, ${c.name}, ${c.employer}, ${c.title},
                  ${c.location}, ${c.program}, ${c.grad_year}, ${c.score}, ${c.reasons}, ${c.url})
          on conflict (source, source_id) do nothing
          returning id`;
        if (done.length) added++;
      }

      visited.push(`${company}: ${candidates.length} matched`);
    }

    /**
     * Green is not the same as working, and should not look like it.
     *
     * The employer filter engages — the typeahead opens and offers matches —
     * but selecting one does not actually narrow the list: the cards that come
     * back are from every employer. The guard above catches that and rejects
     * them rather than saving strangers as your Google contacts, so nothing
     * wrong is stored. But the job then succeeds having done nothing, and a
     * source that reports success while silently achieving nothing is how a
     * gap survives for a week.
     */
    const filterLooksBroken = visited.length > 0 && added === 0
      && visited.every((v) => / 0 matched$/.test(v));

    const warning = filterLooksBroken
      ? 'Alumni search ran but found nobody: the 12Twenty employer filter is not applying. Nothing wrong was saved — the companies are still unfiltered.'
      : null;

    await markSource(sql, 'alumni', true, null, warning);
    if (added) did.push(`${added} new alumni contact${added === 1 ? '' : 's'} at your target companies`);
    log(`alumni: ${visited.join('; ')} -> ${added} added`);

    return { ok: true, added, visited };
  } catch (err) {
    await markSource(sql, 'alumni', false, err.message);
    did.push(`Alumni search FAILED — ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    await ctx.close();
  }
}
