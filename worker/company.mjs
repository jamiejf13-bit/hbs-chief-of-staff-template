// Which company an event title is about.
//
// Shared by the alumni search here and, in spirit, by lib/networking.ts, which
// has the same logic in TypeScript. They cannot literally share a module: that
// file is in the browser bundle, and importing worker code into it is exactly
// what returned 500 on every click of the people buttons — worker/targets.mjs
// reads its JSON with fileURLToPath(import.meta.url), which the bundler cannot
// do. The real fix is to store the derived company on the event row so both
// read a column instead of parsing; until then this file is the canonical
// version and lib/networking.ts should be changed with it.

const EVENT_NOUN =
  /\b(presentation|webinar|panel|info(rmation)? session|coffee chats?|office hours|happy hour|networking|fireside chat|workshop|multi-school|virtual|connection|recruiting|session|functional|pathways|insight|discovery|spotlight|forum|series|summit|program|day)\b/gi;

const STATUS_PREFIX = /^(canceled|cancelled|postponed|rescheduled|new|updated|reminder)\s*:\s*/i;

const NOT_A_COMPANY =
  /^(cpd|real talk|tech basics|hbs|mit|mba|clark group|the clark group|career|alumni)\b/i;

function clean(raw) {
  let name = String(raw ?? '')
    .replace(EVENT_NOUN, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[-–—,&]+$/, '')
    .trim();

  if (name.length < 3 || name.length > 40) return null;
  if (!/[A-Za-z]{3}/.test(name)) return null;
  if (NOT_A_COMPANY.test(name)) return null;
  return name;
}

/**
 * The leading words first; "with X" only as a fallback.
 *
 * The order matters and the first version had it backwards. "Acme - Fireside
 * Chat with Pat Example and Sam Sample" took the `with` branch and produced a
 * company called "Pat Example and Sam Sample" — which the alumni search then
 * dutifully went looking for in the employer directory.
 *
 * Almost every title leads with the employer. The `with` form exists for the
 * co-hosted ones, "HBS & MIT Happy Hour & Networking with Capital One", where
 * the leading words are the schools and reduce to nothing usable. So: try the
 * front, and only reach for `with` when the front yields no company.
 */
export function companyFromEventTitle(title) {
  const cleaned = String(title ?? '').replace(STATUS_PREFIX, '');

  // Split on a spaced hyphen and on " with " too, not only on colons and
  // pipes. "Acme - Fireside Chat with Pat Example and Sam Sample" has
  // neither, so the leading branch kept the whole string, overflowed the
  // forty-character limit, returned null, and handed the title to the `with`
  // fallback — which answered "Pat Example and Sam Sample".
  const leading = clean(cleaned.split(/[:|]|\s[-–—]\s|\swith\s/i)[0]);
  if (leading) return leading;

  const withMatch = /\bwith\s+([A-Z][\w&.' -]{2,40})$/.exec(cleaned.trim());
  return withMatch ? clean(withMatch[1]) : null;
}
