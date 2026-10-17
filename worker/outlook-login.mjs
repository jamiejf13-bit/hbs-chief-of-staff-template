// One-time Outlook sign-in, plus a probe of what the calendar exposes.
//
//   node worker/outlook-login.mjs
//
// Opens a visible browser with its own persistent profile. Sign in with
// your school address (emails.school in lib/profile.json), get to the calendar, and leave it there — the
// script waits for the grid, dumps what it can read, and saves the session so
// later runs need no sign-in.
//
// The browser is Playwright's own Chromium build, not Chrome and not Edge.
// It looks unfamiliar on Windows; that is expected. It has its own profile so
// it knows nothing about your normal browser, which is why you must sign in
// here once, 2FA included.
//
// The profile lives in %LOCALAPPDATA%\hbs-chief-of-staff\outlook-profile, outside the repo. HBS
// credentials never leave this laptop (spec §8).

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PROFILE as OWNER } from './profile.mjs';

// The profile must live OUTSIDE OneDrive.
//
// Chromium keeps a lock file in its user-data-dir. OneDrive's sync locking
// makes Chromium believe another instance already owns the profile, so it
// prints "Opening in existing browser session", hands off to a process that
// is not there, and exits — leaving Playwright attached to about:blank.
export const PROFILE = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'hbs-chief-of-staff',
  'outlook-profile',
);

const PROBE = fileURLToPath(new URL('./.sessions/outlook-probe.json', import.meta.url));
const CAL = 'https://outlook.cloud.microsoft/calendar/view/workweek';

mkdirSync(PROFILE, { recursive: true });
mkdirSync(fileURLToPath(new URL('./.sessions/', import.meta.url)), { recursive: true });

// A crashed run can leave the lock behind and cause the same hand-off.
for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  const p = join(PROFILE, stale);
  if (existsSync(p)) {
    try { rmSync(p, { force: true, recursive: true }); console.log(`cleared stale ${stale}`); } catch { /* ignore */ }
  }
}

console.log(`Profile: ${PROFILE}`);
console.log('(outside OneDrive on purpose — a synced profile breaks Chromium)');

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1400, height: 950 },
  args: ['--disable-blink-features=AutomationControlled'],
});

console.log(`Browser: Playwright Chromium ${ctx.browser()?.version() ?? '(persistent context)'}`);

const page = ctx.pages()[0] ?? (await ctx.newPage());

// Navigate, and say so loudly if it fails. Swallowing this was the bug that
// left an about:blank window with no explanation.
let navigated = false;
for (let attempt = 1; attempt <= 3 && !navigated; attempt++) {
  try {
    await page.goto(CAL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    navigated = true;
  } catch (err) {
    console.log(`  navigation attempt ${attempt} failed: ${String(err.message).split('\n')[0]}`);
    if (attempt === 3) {
      console.log('\nCould not load Outlook automatically.');
      console.log('The window is open — type the address in yourself:');
      console.log(`  ${CAL}`);
    } else {
      await page.waitForTimeout(2000);
    }
  }
}

console.log(`\nSign in as ${OWNER.emails?.school || 'your school address'} and wait until your week shows.`);
console.log('Then leave the window alone — this closes it itself.\n');

const deadline = Date.now() + 8 * 60_000;
let ready = false;
let lastUrl = '';

while (Date.now() < deadline) {
  const seen = await page
    .evaluate(() => {
      const els = document.querySelectorAll('[role="button"][aria-label], [data-app-section] [aria-label]');
      let withTime = 0;
      for (const el of els) {
        if (/\d{1,2}:\d{2}\s*(AM|PM)/i.test(el.getAttribute('aria-label') ?? '')) withTime++;
      }
      return { url: location.href, withTime };
    })
    .catch(() => null);

  if (seen && seen.url !== lastUrl) {
    lastUrl = seen.url;
    console.log(`  now at: ${seen.url.slice(0, 90)}`);
  }
  if (seen && seen.withTime >= 3) { ready = true; break; }

  process.stdout.write('.');
  await page.waitForTimeout(3000);
}

console.log('');

if (!ready) {
  console.error('Did not reach a calendar with events in time.');
  console.error('Whatever sign-in you completed is still saved — just rerun this.');
  await ctx.close();
  process.exit(1);
}

const probe = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('[role="button"][aria-label], [data-app-section] [aria-label]')) {
    const label = el.getAttribute('aria-label') ?? '';
    if (!/\d{1,2}:\d{2}\s*(AM|PM)/i.test(label)) continue;
    out.push({ label: label.slice(0, 300), role: el.getAttribute('role') });
  }
  return { url: location.href, title: document.title, count: out.length, samples: out.slice(0, 40) };
});

writeFileSync(PROBE, JSON.stringify(probe, null, 2));

console.log(`Signed in — session saved.`);
console.log(`Found ${probe.count} timed entries; sample written to worker/.sessions/outlook-probe.json\n`);
for (const s of probe.samples.slice(0, 8)) console.log('  ', s.label.slice(0, 110));

await ctx.close();
console.log('\nDone.');
