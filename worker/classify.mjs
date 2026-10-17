// What kind of thing an email is, decided once by the model.
//
// Keyword scoring went as far as it could and then started failing at the one
// job that matters: a recruiting approach from Apple scored 3, below five
// separate HBS Salsa emails, because "salsa" carried urgency words and "thinks
// you'd be great for Apple" did not. Every fix made the regex longer and the
// next miss more likely.
//
// So the KIND is decided first and sets a floor; urgency only orders things
// within a kind. An Apple recruiter cannot rank below a dance class however
// politely it is worded.
//
// Classified once per message and stored. Re-reading the same subject on every
// pass would be both slow and a waste of money.

import Anthropic from '@anthropic-ai/sdk';
import { PROFILE } from './profile.mjs';
import { TARGETS } from './targets.mjs';

const MODEL = 'claude-opus-5';

/**
 * The categories, and what each is worth before urgency is considered.
 *
 * Drawn from a real student mailbox rather than invented: every one of these
 * had several examples among the open items.
 *
 * The floor is what makes this better than keywords. Anything recruiting
 * starts above anything social, so the ranking cannot be talked out of the
 * owner's stated priorities by a well-chosen subject line.
 */
export const CATEGORIES = {
  recruiting: {
    floor: 20,
    what: 'A company, recruiter, or alum about roles, internships, applications, '
      + 'interviews, info sessions or recruiting events. Includes CPD and career services.',
  },
  networking: {
    floor: 18,
    what: 'A person arranging or following up a coffee chat, intro, 1:1 or office hours. '
      + 'The point is that a human is waiting on the student\'s reply.',
  },
  class_action: {
    floor: 16,
    what: 'A course requiring the student to DO something: a survey, problem set, exercise, '
      + 'poll, submission or pre-class task, usually with a deadline.',
  },
  class_info: {
    floor: 6,
    what: 'Course announcements with nothing to do — module wraps, posted models, '
      + 'grades, reading lists, logistics that need no action.',
  },
  club: {
    floor: 5,
    what: 'Club events, memberships, sign-ups and club-run sessions. Real but optional.',
  },
  social: {
    floor: 4,
    what: 'Friends, dinners, parties, section social life, merchandise orders.',
  },
  admin: {
    floor: 2,
    what: 'Accounts, passwords, security notices, policy, facilities, receipts and '
      + 'confirmations of things already done.',
  },
  news: {
    floor: 0,
    what: 'Newsletters, digests, press and anything whose purpose is to be read '
      + 'rather than acted on.',
  },
};

const SYSTEM = [
  `You sort one ${PROFILE.school || 'HBS'} student's email into categories. They are an MBA student in their ${PROFILE.year || 'RC'} year.`,
  '',
  `Their stated priorities, in order: recruiting for a ${TARGETS.timing || 'summer internship'}; job`,
  'postings that fit their goals; keeping up with class assignments.',
  '',
  'Categories:',
  ...Object.entries(CATEGORIES).map(([k, v]) => `- ${k}: ${v.what}`),
  '',
  'Also judge whether it NEEDS THE STUDENT: does a person or a deadline require an action',
  'from them that has not obviously happened? A receipt, a confirmation, an',
  'announcement and a newsletter do not. A survey, an RSVP, an unanswered question',
  'and an application deadline do.',
  '',
  'Answer with one JSON array and nothing else. One object per email, in the order',
  'given, each: {"i": <index>, "category": "<one of the above>", "needs_owner": true|false,',
  '"why": "<six words at most>"}',
].join('\n');

/**
 * Classify a batch.
 *
 * Subject and sender only. The body is not read: it is not needed to tell a
 * recruiter from a newsletter, and not reading it keeps this well inside what
 * the mailbox reader already sees.
 */
export async function classify(items, apiKey) {
  if (!items.length) return [];
  const client = new Anthropic({ apiKey });

  const list = items
    .map((m, i) => `${i}. from="${m.from_name ?? '?'}" folder="${m.folder ?? 'Inbox'}" subject="${m.subject}"`)
    .join('\n');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: list }],
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // The model is asked for bare JSON, but a stray fence costs nothing to allow.
  const json = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Classifier did not return JSON: ${text.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Classifier did not return an array');

  // Anything it invents a category for is dropped rather than trusted — an
  // unknown category would silently get a floor of zero and vanish.
  return parsed
    .filter((r) => typeof r.i === 'number' && r.category in CATEGORIES)
    .map((r) => ({
      index: r.i,
      category: r.category,
      needs_owner: Boolean(r.needs_owner),
      why: String(r.why ?? '').slice(0, 60),
    }));
}
