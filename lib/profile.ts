import raw from './profile.json';

/**
 * Who this console belongs to.
 *
 * Everything personal — name, section, courses, emails — lives in
 * lib/profile.json so the code never has to. The worker reads the same file
 * through worker/profile.mjs, so the page and the worker cannot disagree.
 */
export interface Course {
  code: string;
  name: string;
  canvasCode?: string;
  leadDays?: number;
}

export interface Profile {
  name: string;
  firstName: string;
  pronouns: string;
  school: string;
  program: string;
  classYear: number;
  year: string;
  section: string;
  term: string;
  appName: string;
  shortName: string;
  timezone: string;
  city: string;
  awakeHours: { start: number; end: number };
  emails: { school: string; personal: string };
  canvas: { baseUrl: string };
  courses: Course[];
  participation: { path: string; sheet: string };
  outreachIntro: string;
}

export const PROFILE = raw as unknown as Profile;

/** Course codes, e.g. ['FIN1', 'FRC', ...]. */
export const COURSE_CODES = PROFILE.courses.map((c) => c.code);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches any configured course code as a word, case-insensitive. */
export const COURSE_RE = new RegExp(`\\b(${COURSE_CODES.map(escapeRe).join('|') || '(?!)'})\\b`, 'i');
