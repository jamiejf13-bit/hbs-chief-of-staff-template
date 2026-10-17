// What your decisions about people teach the scorer.
//
// Rules could not solve this one. Target industries come from lib/targets.json,
// but a company's industry is usually not in its name:
// "Mount Sinai Health System" announces itself, "Acme" and "Initech" do not,
// even when they are exactly the kind of company being targeted. Any
// keyword list is therefore guessing, and the first run proved it by filling
// the list with hospital strategy roles.
//
// You can tell at a glance. So the scorer stops guessing: every decision you
// make writes the words of that employer and title into people_signals, and
// the next person who looks the same carries the weight of it.
//
import { TARGETS } from './targets.mjs';

// Three properties this keeps, because the rest of the project's scoring keeps
// them and a ranking you cannot argue with is one you stop trusting:
//
//   · it is counting, not a model — the arithmetic fits in a sentence
//   · the adjustment is CAPPED, so learning tilts the order and never
//     overrules the fact that someone does the work you want
//   · whatever it did is said out loud, in the reasons on the row

/**
 * Words the RULES already know about, which must never be learned from.
 *
 * Passing on a Chief Strategy Officer at a university taught a penalty on
 * "strategy" — and "strategy" is in the title of almost everyone being
 * targeted, so a good match dropped a point for it too. The word was never the
 * reason for passing; "universidad" was.
 *
 * Your functions, industries and locations are already scored explicitly. Those
 * are the terms the rules can see. Learning exists for what they cannot — a
 * company name that gives no clue what the company does — so it is confined to
 * exactly that, and double-counting becomes impossible by construction.
 */
const RULE_WORDS = new Set(
  [
    ...TARGETS.functions.flatMap((f) => f.terms),
    ...TARGETS.industries.flatMap((i) => i.terms),
    ...TARGETS.locations.primary,
    ...TARGETS.locations.secondary,
  ].flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean),
);

/** Words that carry no signal about an employer. */
const STOP = new Set([
  'the', 'and', 'of', 'for', 'at', 'in', 'a', 'an', 'to', 'on', 'with',
  'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'group',
  'holdings', 'partners', 'international', 'global', 'us', 'usa',
  'senior', 'manager', 'director', 'associate', 'lead', 'head', 'vice',
  'president', 'chief', 'officer', 'intern', 'mba', 'analyst', 'specialist',
]);

/**
 * The words a decision should teach.
 *
 * Employer and title together, because "Senior Manager of People Strategy at
 * Rightway Healthcare" should teach "healthcare" — not only "rightway", which
 * you will never see again.
 */
export function tokensFor({ employer = '', title = '' }) {
  return [...new Set(
    `${employer} ${title}`
      .toLowerCase()
      .split(/[^a-z0-9&]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !RULE_WORDS.has(w)),
  )];
}

/**
 * What your decisions have taught, read straight from the decisions.
 *
 * Not a stored table. people.status already holds every call you have made, so
 * a people_signals table would be a second copy of the same facts, free to
 * drift from them — and the route that wrote it had to import this module,
 * which pulled worker code into Next's bundle and returned 500 on every click.
 *
 *   not_interested  -> down
 *   to_contact      -> up
 *   contacted       -> up    (you went as far as messaging them)
 */
export async function loadSignals(sql) {
  const rows = await sql`
    select employer, title, status
      from people
     where status in ('not_interested', 'to_contact', 'contacted')`;

  const map = new Map();
  for (const r of rows) {
    const direction = r.status === 'not_interested' ? 'down' : 'up';
    for (const token of tokensFor(r)) {
      const s = map.get(token) ?? { up: 0, down: 0 };
      s[direction] += 1;
      map.set(token, s);
    }
  }
  return map;
}

/** How far learning may move a score in either direction. */
export const CAP = 4;

/**
 * The learned adjustment for one person.
 *
 * A token counts once you have reacted to it at least twice, so a single
 * dismissal of one person does not start suppressing a whole sector on the
 * strength of one click. The strongest few tokens are used rather than the sum
 * of all of them: an employer with eight words would otherwise outweigh one
 * with two purely by being wordy.
 */
export function learnedAdjustment(signals, person) {
  if (!signals?.size) return { delta: 0, reason: null };

  const hits = [];
  for (const token of tokensFor(person)) {
    const s = signals.get(token);
    if (!s) continue;
    const seen = s.up + s.down;
    if (seen < 2) continue;
    // -1 (always rejected) .. +1 (always wanted), scaled by how often you have
    // actually said so, levelling off rather than growing without limit.
    const lean = (s.up - s.down) / seen;
    hits.push({ token, lean, seen, weight: lean * Math.min(1, seen / 4) });
  }
  if (!hits.length) return { delta: 0, reason: null };

  hits.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const top = hits.slice(0, 3);
  const raw = top.reduce((n, h) => n + h.weight, 0) * 2;
  const delta = Math.round(Math.max(-CAP, Math.min(CAP, raw)));
  if (delta === 0) return { delta: 0, reason: null };

  const worst = top[0];
  const reason = delta < 0
    ? `you have passed on "${worst.token}" before`
    : `you have been interested in "${worst.token}" before`;

  return { delta, reason };
}
