// One rule, because one bug keeps happening.
//
// A React hook declared after an early return is called on some renders and
// not others, and React answers by throwing — the page becomes "Application
// error: a client-side exception has occurred" and the console is gone. That
// has now taken the live site down twice, both times in app/page.tsx, both
// times a useState written next to the function that uses it rather than up
// with the other hooks.
//
// I wrote a checker for it by hand after the first one and it missed the
// second, because the early returns are nested inside `if (...) {` blocks and
// my regex only looked for a return at the top level of the component. The
// rules-of-hooks rule is the real implementation of this check, maintained by
// the people who wrote the constraint, and it catches both shapes.
//
// Deliberately narrow. A full Next lint config would report hundreds of
// pre-existing style findings on a codebase that has never been linted, and
// `npm run verify` would fail for reasons nobody intends to fix — so the
// check would be turned off within a week. Two rules that have actually cost
// something are worth more than two hundred that have not.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'db/**'],
  },
  {
    files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The one that has taken the site down.
      'react-hooks/rules-of-hooks': 'error',
      // A stale dependency array is how the tracker rendered twenty-four
      // roles as nothing at all: the list was memoised against a static
      // import, then the import became state and the array was never updated.
      // A warning rather than an error — some are deliberate — but it would
      // have pointed straight at that one.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  /**
   * The worker and scripts are plain Node .mjs that nothing else type-checks.
   * They were outside lint entirely, which is how worker/loop.mjs shipped a
   * call to `signInTick()` — a function that did not exist — and threw a
   * ReferenceError from a timer every fifteen seconds. `no-undef` alone would
   * have caught it; the rest of eslint's recommended set is the cheap kind of
   * mistake (unreachable code, duplicate keys, a misspelled variable) that a
   * process running unattended on a laptop has no other way to report.
   */
  {
    files: ['worker/**/*.mjs', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
  {
    // The Playwright sources pass callbacks to page.evaluate(), which run
    // inside the page, where these exist. Only these three — the full browser
    // set includes names like `name` and `status` that would hide real typos.
    files: ['worker/**/*.mjs'],
    languageOptions: {
      globals: { document: 'readonly', location: 'readonly', window: 'readonly' },
    },
  },
];
