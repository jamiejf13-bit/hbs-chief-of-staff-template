import type { CalEvent, JobPosting } from './types';
import TARGETS from './targets.json';

/**
 * Who to reach out to, and where to find them.
 *
 * LINKEDIN IS NOT AUTOMATED HERE, AND SHOULD NOT BE.
 *
 * This builds search URLs for the user to click. It does not sign in, read, or
 * scrape anything. Driving a logged-in LinkedIn session would breach LinkedIn's
 * terms and risk a restriction on the account the student is recruiting with —
 * the one asset in this whole system that cannot be rebuilt from a backup. The
 * same rule already governs worker/gmail.mjs, where LinkedIn is read only as the
 * alert emails LinkedIn itself sends (spec §2).
 *
 * A generated search gives most of the value anyway: the hard part is knowing
 * WHICH company, WHICH function and WHICH alumni filter to combine, and that is
 * exactly what this file knows and a blank search box does not.
 */

/** Companies worth networking into, newest signal first. */
export interface NetworkTarget {
  company: string;
  /** Why this company is on the list — shown, so a bad parse is visible. */
  why: string;
  /** Strongest first: a registered event beats a job posting not yet acted on. */
  weight: number;
  searches: NetworkSearch[];
}

export interface NetworkSearch {
  label: string;
  href: string;
}

/**
 * Pull a company out of a 12Twenty event title.
 *
 * Titles are written by employers and recruiters, not by a schema:
 *
 *   "Google Functional Panel: Product Management at Google"
 *   "BCG Presentation: New York Metro Area Offices Panel 2026"
 *   "HBS & MIT Happy Hour & Networking with Capital One"
 *   "Johnson & Johnson Multi-School Webinar | International Recruitment"
 *
 * The company is almost always the leading words, but "HBS & MIT Happy Hour
 * ... with Capital One" puts it at the end. So: take whatever follows "with"
 * when there is one, otherwise the text before the first separator, then strip
 * the event-type nouns that cling to it.
 */
const EVENT_NOUN =
  /\b(presentation|webinar|panel|info(rmation)? session|coffee chats?|office hours|happy hour|networking|fireside chat|workshop|multi-school|virtual|connection|recruiting|session|functional|pathways|insight|discovery|spotlight|forum|series|summit|program|day)\b/gi;

/** 'Canceled: ...' and 'POSTPONED: ...' are statuses, not employers. */
const STATUS_PREFIX = /^(canceled|cancelled|postponed|rescheduled|new|updated|reminder)\s*:\s*/i;

/**
 * Things that reach the company slot but are not employers.
 *
 * Found by running the extractor over real 12Twenty titles rather than
 * imagined: CPD runs the careers office, 'Real Talk' is an alumni series, and
 * the school names come from co-hosted events ('HBS & MIT Happy Hour').
 */
const NOT_A_COMPANY =
  /^(cpd|real talk|tech basics|hbs|mit|mba|clark group|the clark group|career|alumni)\b/i;

export function companyFromEventTitle(title: string): string | null {
  title = title.replace(STATUS_PREFIX, '');
  const withMatch = /\bwith\s+([A-Z][\w&.' -]{2,40})$/.exec(title.trim());
  let name = withMatch ? withMatch[1] : title.split(/[:|–—]/)[0];

  name = name.replace(EVENT_NOUN, ' ').replace(/\s{2,}/g, ' ').trim();
  name = name.replace(/[-–—,&]+$/, '').trim();

  // Two characters is not a company, and a long string means the split failed.
  if (name.length < 3 || name.length > 40) return null;
  // A title that is all event-type words leaves nothing worth searching for.
  if (!/[A-Za-z]{3}/.test(name)) return null;
  if (NOT_A_COMPANY.test(name)) return null;
  return name;
}

/**
 * Employers the student has said are not targets, from
 * lib/targets.json `exclude.employers`. Each entry is a regex fragment, matched
 * with a word boundary in front and a negative lookahead behind, so
 * "strategy\s*&" matches although "&" cannot carry a word boundary.
 */
const EXCLUDED_EMPLOYERS: string[] =
  ((TARGETS as { exclude?: { employers?: string[] } }).exclude?.employers ?? [])
    .filter((s) => typeof s === 'string' && s.trim());
const OFF_TARGET = EXCLUDED_EMPLOYERS.length
  ? new RegExp(`\\b(${EXCLUDED_EMPLOYERS.join('|')})(?!\\w)`, 'i')
  : /(?!)/;

/**
 * One LinkedIn people search per function, scoped to the company.
 *
 * The HBS filter is in the keywords rather than as LinkedIn's school facet,
 * because the facet needs a numeric school id that only appears once you are
 * signed in and filtering by hand. Keywords work from a cold click.
 */
function searchesFor(company: string): NetworkSearch[] {
  const q = (terms: string) =>
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      `"${company}" "Harvard Business School" ${terms}`,
    )}`;

  return [
    { label: 'HBS alumni there', href: q('') },
    ...TARGETS.functions.slice(0, 3).map((f) => ({
      label: f.name,
      href: q(f.terms.slice(0, 2).map((t) => `"${t}"`).join(' OR ')),
    })),
  ];
}

/**
 * Build the network list from what the student has actually engaged with.
 *
 * Registered events first: signing up for something is a far stronger signal
 * than a job board matching on keywords, and it means the outreach has a
 * reason to exist ("we met at the Google panel") rather than being cold.
 */
export function networkTargets(
  events: CalEvent[],
  jobs: JobPosting[],
  limit = 6,
): NetworkTarget[] {
  const found = new Map<string, NetworkTarget>();

  const add = (company: string, why: string, weight: number) => {
    const key = company.toLowerCase();
    if (OFF_TARGET.test(company)) return;
    // 'Google' and 'Google Functional' are one company. Whichever name is
    // shorter is the real one, so the longer entry folds into it rather than
    // spending a second slot on the same employer.
    for (const [k, v] of found) {
      if (key.startsWith(k + ' ')) {
        if (weight > v.weight) { v.weight = weight; v.why = why; }
        return;
      }
      if (k.startsWith(key + ' ')) {
        found.delete(k);
        found.set(key, { company, why: weight >= v.weight ? why : v.why,
                         weight: Math.max(weight, v.weight), searches: searchesFor(company) });
        return;
      }
    }

    const held = found.get(key);
    if (held) {
      if (weight > held.weight) { held.weight = weight; held.why = why; }
      return;
    }
    found.set(key, { company, why, weight, searches: searchesFor(company) });
  };

  for (const e of events) {
    // Deleted events and dismissed jobs are already filtered out in
    // lib/state.ts, so this does not re-check what the query guarantees.
    if (e.source !== '12twenty' || !e.registered) continue;
    const company = companyFromEventTitle(e.title);
    if (company) add(company, `You registered for their ${shortEvent(e.title)}`, 3);
  }

  for (const j of jobs) {
    add(j.company, `They posted ${j.title}`, 1);
  }

  return [...found.values()].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/** "Google Functional Panel: Product Management at Google" -> "panel". */
function shortEvent(title: string): string {
  const m = /\b(presentation|webinar|panel|info(?:rmation)? session|coffee chat|office hours|happy hour|fireside chat|workshop)\b/i.exec(title);
  return m ? m[1].toLowerCase() : 'event';
}
