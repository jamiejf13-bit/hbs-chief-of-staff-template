// Who this console belongs to — the worker's view of lib/profile.json.
//
// One file, read by both the worker and the page, so nothing personal is
// hard-coded anywhere else. Edit lib/profile.json, not this.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROFILE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../lib/profile.json', import.meta.url)), 'utf8'),
);

/** Course codes, e.g. ['FIN1', 'FRC', ...]. */
export const COURSE_CODES = PROFILE.courses.map((c) => c.code);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches any configured course code as a word, case-insensitive. */
export const COURSE_RE = new RegExp(`\\b(${COURSE_CODES.map(escapeRe).join('|') || '(?!)'})\\b`, 'i');

/** Canvas course_code → short code, e.g. { 'MKT-X': 'MKT' }. */
export const CANVAS_COURSE_CODES = Object.fromEntries(
  PROFILE.courses.map((c) => [c.canvasCode || `${c.code}-${PROFILE.section}`, c.code]),
);
