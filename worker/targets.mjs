// Scoring against the owner's target roles.
//
// The definition itself lives in lib/targets.json — one file, read by both the
// worker and the page, so the filters that rank a role and the copy that
// describes the search cannot drift apart. This module only turns it into a
// score.
//
// Everything it decides is reported as a reason, because a ranking you cannot
// argue with is one you will stop trusting.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TARGETS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../lib/targets.json', import.meta.url)), 'utf8'),
);

/**
 * Does the text contain one of these terms, as a WORD?
 *
 * This was `text.includes(t)`, and plain substring matching put a hospital in
 * the technology industry: the term "ai" matched inside "Mount Sinai", so
 * "Director, Corporate Development, Mount Sinai Health System" scored as a tech
 * role. The same bug reaches every short term — "ai" is also inside "retail",
 * "maintenance" and "training", and "ey" inside "eyewear".
 *
 * Hyphens count as word characters here so "go-to-market" cannot match inside a
 * longer hyphenated phrase, and a term is escaped before it becomes a pattern
 * because "l.e.k" would otherwise match "leak".
 *
 * The cost is that a term no longer matches inside a compound: "tech" stops
 * matching "fintech", which is why fintech is now listed in its own right.
 * Explicit beats accidental — the accidental version was tagging hospitals.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const has = (text, terms) =>
  terms.find((t) => new RegExp(`(?<![\\w-])${escapeRe(t)}(?![\\w-])`, 'i').test(text));

/**
 * Score one role.
 *
 * Three gates, applied before anything is added, because each of them means
 * "this is the wrong thing" rather than "this is a weaker match":
 *
 *   excluded term   anything in exclude.terms (e.g. engineering roles)
 *   not an internship  the search is for a summer internship (TARGETS.timing)
 *   too senior      an RC cannot take a Director role
 */
export function scoreRole(title, location = '', extra = '') {
  const t = `${title} ${extra}`.toLowerCase();
  const loc = (location ?? '').toLowerCase();
  const reasons = [];

  const banned = has(t, TARGETS.exclude.terms);
  if (banned) return { score: -10, reasons: [`Not a target: ${banned}`] };

  /**
   * "staff" is in the seniority list to catch a Staff Engineer, and it also
   * sits inside "Chief of Staff" — so a Chief of Staff Intern was rejected as
   * too senior, which it plainly is not. "Staff" there is not a level. (To
   * rule Chief of Staff roles out entirely, add it to exclude.terms; that gate
   * runs first.)
   */
  const seniority = /chief of staff/i.test(t)
    ? TARGETS.exclude.seniority.filter((x) => x !== 'staff')
    : TARGETS.exclude.seniority;
  const senior = has(t, seniority);
  if (senior) return { score: -10, reasons: [`Too senior: ${senior}`] };

  if (!/\b(intern|interns|internship|mba)\b/.test(t)) {
    return { score: -5, reasons: ['Not an internship'] };
  }

  let score = 4;
  reasons.push(TARGETS.timing);

  // Functions carry their priority order: the first is worth more than the
  // fifth, which is what "in priority order" has to mean to be useful.
  const fnIndex = TARGETS.functions.findIndex((f) => has(t, f.terms));
  if (fnIndex >= 0) {
    score += 5 - fnIndex;
    reasons.push(TARGETS.functions[fnIndex].name);
  }

  const industry = TARGETS.industries.find((i) => has(t, i.terms));
  if (industry) { score += 1; reasons.push(industry.name); }

  /**
   * Location is a tie-breaker between roles you might want, never a reason
   * to surface one you would not.
   *
   * Awarded unconditionally it was worth three points, which took any summer
   * internship in the primary city to seven — the same score as a genuine strategy
   * role — and the first real scan filled the list with Tax Operations,
   * Accounting and Real Estate & Builds. Being in the right city is not a
   * qualification. It counts only once the work already matches.
   */
  if (fnIndex >= 0 || industry) {
    const city = has(loc, TARGETS.locations.primary);
    if (city) {
      score += 3; reasons.push(`Primary city (${city})`);
    } else if (has(loc, TARGETS.locations.secondary)) {
      score += 2; reasons.push('Target city');
    }
  }

  // Remote is explicitly not a target, so a remote-only posting loses ground
  // rather than gaining it.
  if (!TARGETS.remote_is_a_target && /\bremote\b/.test(loc) && !has(loc, TARGETS.locations.primary)) {
    score -= 2; reasons.push('Remote, which you are not targeting');
  }

  return { score, reasons };
}
