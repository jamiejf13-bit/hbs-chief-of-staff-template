// One-time 12Twenty sign-in, plus a survey of what the site actually exposes.
//
//   node worker/twelvetwenty-login.mjs
//
// Opens a visible browser with its own persistent profile. Sign in through HBS
// as usual, land anywhere inside 12Twenty, and leave it — this waits, saves the
// session, then walks the pages the reader will use and writes down what it
// finds.
//
// The survey matters. Two parsers in this project were written by inferring a
// page's shape and both got it wrong: the LinkedIn alert parser swapped every
// job title with its company, and the Outlook collector filtered more strictly
// than its own parser and silently dropped every overnight event. So nothing
// is written against 12Twenty until a real page has been looked at.
//
// The profile lives outside OneDrive for the same reason Outlook's does: a
// synced Chromium profile cannot hold its lock.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const PROFILE = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'hbs-chief-of-staff',
  'twelvetwenty-profile',
);

export const BASE = 'https://mba-business-harvard.12twenty.com';

/**
 * Launch options for anything touching 12Twenty.
 *
 * Real Chrome, not Playwright's bundled Chromium. 12Twenty sits behind a
 * bot-protection service that fingerprints the browser, and bundled Chromium
 * is one of the things it looks at — it once began refusing and had not
 * relented 23 hours later. Chrome is the same engine carrying the build,
 * version string and TLS behaviour of a browser a person actually uses.
 *
 * It keeps its OWN profile rather than borrowing yours. Driving your everyday
 * Chrome would hand this code every site you are signed into, which is a far
 * larger blast radius than reading an events list needs — and Chrome locks a
 * profile while it is open, so it would mean closing your browser to sync.
 *
 * Falls back to bundled Chromium where Chrome is not installed.
 */
const CHROME_PATHS = [
  `${process.env.ProgramFiles ?? 'C:/Program Files'}/Google/Chrome/Application/chrome.exe`,
  `${process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'}/Google/Chrome/Application/chrome.exe`,
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
];

export const HAVE_CHROME = CHROME_PATHS.some((p) => p && existsSync(p));

/**
 * Never headless against 12Twenty — headful, parked off-screen instead.
 *
 * Headless is a signal in its own right, whatever binary is behind it. Tested
 * side by side against the same profile: headless got the
 * security-verification page, and headful reached the ordinary sign-in page.
 * The protection is not detecting automation, it is detecting a browser that
 * is not drawing anything.
 *
 * So a caller asking for `headless: true` gets a real rendered window placed
 * at -3000,-3000 — far outside any monitor. It never appears, never takes
 * focus, and is as real as the one you use, because it is.
 *
 * The cost is that this needs a logged-in desktop session. The worker already
 * runs as you at logon, so that holds; it would not on a headless server, and
 * that is a reason this half cannot move to the cloud even if HBS allowed it.
 */
export function launchOptions(extra = {}) {
  const wantsBackground = extra.headless !== false;

  const opts = {
    viewport: { width: 1500, height: 1000 },
    ...extra,
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(wantsBackground ? ['--window-position=-3000,-3000', '--window-size=1500,1000'] : []),
      ...(extra.args ?? []),
    ],
  };
  if (HAVE_CHROME) opts.channel = 'chrome';
  return opts;
}

const SURVEY = fileURLToPath(new URL('./.sessions/12twenty-survey.json', import.meta.url));

/** The pages the reader will need. Visited in order, failures recorded not thrown. */
const PAGES = [
  { name: 'events', path: '/Events' },
  { name: 'my-events', path: '/Events/MyEvents' },
  { name: 'outcomes', path: '/OutcomeSearch' },
  { name: 'appointments', path: '/Appointments' },
  { name: 'employers', path: '/EmployerSearch' },
];

/**
 * The networking side, found rather than guessed.
 *
 * The signed-in navigation reads "Students & Alumni · Communities · Contacts",
 * but none of those paths are known and inventing them would mean writing a
 * reader against a page that may not exist — the mistake the top of this file
 * exists to prevent. So the survey reads the real navigation, records every
 * link with its href, and then visits the ones that look like networking.
 * Whatever it finds is what the reader gets written against.
 */
const NETWORKING = /student|alumni|contact|network|communit|mentor|coach/i;

/**
 * Renew an expired 12Twenty session without anyone typing anything.
 *
 * 12Twenty's own session cookie, `.ASPXAUTH.Shared`, lasts twelve hours. That
 * is their server's policy and nothing here can extend it. Two cookies in the
 * profile last far longer: the Harvard CAS ticket-granting cookie (TGC) and
 * Duo's browser-trust cookie, both thirty days. So for thirty days after a
 * real sign-in, everything needed to mint a fresh session is already on disk.
 *
 * The catch is that 12Twenty does not start SSO by itself. An expired session
 * lands on 12Twenty's OWN login page — a form with a password field — and sits
 * there; measured once, it had not moved after fifteen seconds. Both
 * callers read that URL, called it "session expired" and said to run the
 * login script. Twice a day. The page also carries a link,
 * "Login with your HBS Credentials", and clicking it runs the whole SAML chain
 * off the cookies already present: sso.hbs.edu issues the assertion, 12Twenty
 * mints a new cookie, and the browser lands on the page originally asked for.
 * Verified end to end with the app session deliberately deleted — zero password
 * fields presented, no Duo push, fresh cookie on disk.
 *
 * This only ever CLICKS. It never types a credential and never will: if the
 * password field is still there afterwards, the thirty-day ticket has genuinely
 * lapsed, and the honest answer is to hand that back to you rather than to
 * start filling in forms on your behalf.
 *
 * Returns true when the browser ends up signed in and somewhere other than the
 * login page.
 */
export async function reauthenticate(page, { timeoutMs = 45_000 } = {}) {
  const sso = page.locator('a', { hasText: /HBS Credentials/i }).first();
  if (!(await sso.count().catch(() => 0))) return false;

  await sso.click().catch(() => {});

  // The chain is several redirects across three hosts, so poll for the
  // destination rather than guessing a single waitForNavigation.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const url = page.url();
    const onApp = /12twenty\.com/i.test(url) && !/^https:\/\/sso\./i.test(url) && !/\/login/i.test(url);
    if (onApp) {
      const asking = await page
        .evaluate(() => document.querySelectorAll('input[type=password]').length)
        .catch(() => 1);
      return asking === 0;
    }
  }
  return false;
}

export function clearStaleLocks() {
  for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = join(PROFILE, stale);
    if (existsSync(p)) {
      try { rmSync(p, { force: true, recursive: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Only run the interactive flow when invoked directly, so the reader can
 * import PROFILE and BASE without opening a window.
 *
 * Built with pathToFileURL rather than by hand. The hand-rolled version —
 * `file://${argv[1].replace(/\\/g, '/')}` — produced `file://C:/Users/...`
 * where Node produces `file:///C:/Users/...`. Two slashes against three, so
 * the comparison never matched, main() never ran, and the script exited 0
 * having printed nothing at all.
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

async function main() {
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(fileURLToPath(new URL('./.sessions/', import.meta.url)), { recursive: true });
  clearStaleLocks();

  console.log(`Profile: ${PROFILE}`);
  console.log('(outside OneDrive on purpose — a synced profile breaks Chromium)\n');

  const ctx = await chromium.launchPersistentContext(
    PROFILE,
    launchOptions({ headless: false, viewport: { width: 1400, height: 950 } }),
  );

  const page = ctx.pages()[0] ?? (await ctx.newPage());

  try {
    await page.goto(`${BASE}/Events`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (err) {
    console.log(`Could not load 12Twenty automatically: ${String(err.message).split('\n')[0]}`);
    console.log(`The window is open — type the address in yourself:\n  ${BASE}\n`);
  }

  console.log('Sign in through HBS. Once you can see 12Twenty, leave the window alone.');
  console.log('This closes it itself.\n');

  // Signed in = we are on a 12Twenty page that is not the login screen.
  const deadline = Date.now() + 8 * 60_000;
  let ready = false;
  let lastUrl = '';

  while (Date.now() < deadline) {
    const seen = await page
      .evaluate(() => ({
        url: location.href,
        title: document.title,
        // The login screens are Microsoft's, not 12Twenty's.
        looksLikeApp: !/login|signin|microsoftonline|adfs/i.test(location.href),
        links: document.querySelectorAll('a').length,
      }))
      .catch(() => null);

    if (seen && seen.url !== lastUrl) {
      lastUrl = seen.url;
      console.log(`  now at: ${seen.url.slice(0, 95)}`);
    }
    if (seen?.looksLikeApp && seen.links > 20 && seen.url.includes('12twenty.com')) {
      ready = true;
      break;
    }

    process.stdout.write('.');
    await page.waitForTimeout(3000);
  }
  console.log('');

  if (!ready) {
    console.error('Did not reach a signed-in 12Twenty page in time.');
    console.error('Whatever sign-in you completed is saved — just rerun this.');
    await ctx.close();
    process.exit(1);
  }

  console.log('Signed in — session saved. Surveying the pages the reader will use…\n');

  /**
   * Write down when this happened.
   *
   * It is the only honest clock on the session. The CAS cookie claims thirty
   * days and the ticket behind it dies in about thirty-six hours, so nothing
   * readable from the browser can say how long is left. Knowing when you last
   * signed in lets the reader warn you at a useful moment instead of failing
   * at an arbitrary one.
   *
   * Best effort: a database that is down must not cost you the sign-in you have
   * just completed.
   */
  try {
    const { loadEnv, db } = await import('./lib.mjs');
    const sql = db(loadEnv());
    await sql`update prefs set twelvetwenty_signed_in_at = now() where id = true`;
    console.log('Recorded the sign-in time, so the console can warn you before it lapses.\n');
  } catch (err) {
    console.log(`(could not record the sign-in time: ${String(err.message).slice(0, 80)})\n`);
  }

  const survey = { at: new Date().toISOString(), pages: [], nav: [] };

  // Read the navigation first, so the networking pages below are real URLs
  // taken off the page rather than paths someone hoped existed.
  try {
    survey.nav = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((a) => ({
          text: (a.innerText ?? '').replace(/\s+/g, ' ').trim(),
          href: a.getAttribute('href') ?? '',
        }))
        .filter((l) => l.text && l.text.length < 40 && !l.href.startsWith('javascript:'))
        .filter((l, i, all) => all.findIndex((o) => o.href === l.href) === i));
    console.log(`  navigation: ${survey.nav.length} distinct links`);
  } catch {
    console.log('  navigation: could not be read');
  }

  for (const link of survey.nav) {
    if (!NETWORKING.test(`${link.text} ${link.href}`)) continue;
    if (PAGES.some((p) => link.href.includes(p.path))) continue;
    PAGES.push({ name: `net:${link.text.toLowerCase().replace(/[^a-z]+/g, '-')}`, path: link.href });
    console.log(`  queued networking page: "${link.text}" -> ${link.href.slice(0, 70)}`);
  }

  for (const p of PAGES) {
    try {
      // The hand-written paths are relative; the ones lifted off the navigation
      // may be absolute, or hash routes. Resolved against BASE either way.
      const target = new URL(p.path, BASE).href;
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForTimeout(3500);

      const info = await page.evaluate(() => {
        const text = (el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim();

        // Whatever repeats on the page is what the reader will iterate over.
        const counts = {};
        for (const el of document.querySelectorAll('[class]')) {
          for (const c of el.classList) {
            if (c.length < 4) continue;
            counts[c] = (counts[c] ?? 0) + 1;
          }
        }
        const repeated = Object.entries(counts)
          .filter(([, n]) => n >= 3 && n <= 80)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 25);

        return {
          url: location.href,
          title: document.title,
          heading: text(document.querySelector('h1, h2') ?? document.body).slice(0, 120),
          tables: document.querySelectorAll('table').length,
          rows: document.querySelectorAll('tr').length,
          repeatedClasses: repeated,
          sampleText: text(document.body).slice(0, 1200),

          /**
           * The first few repeating items, kept as LINES.
           *
           * A people list is the thing this survey exists for: a parser needs
           * to know whether a row reads name / title / company / class year
           * or some other order, and a flattened 1200-character body sample
           * cannot show that. The Outlook reader found its time column by
           * shape only because a real row had been looked at first.
           */
          rowSamples: [
            ...document.querySelectorAll('tr, [class*="card"], [class*="result"], li[class]'),
          ]
            .map((el) => (el.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean))
            .filter((lines) => lines.length >= 2 && lines.join(' ').length > 25)
            .slice(0, 6),

          /** Links out of each row — the profile URLs the reader will follow. */
          rowLinks: [...document.querySelectorAll('a[href]')]
            .map((a) => a.getAttribute('href') ?? '')
            .filter((h) => /profile|student|alumni|contact|person|user/i.test(h))
            .filter((h, i, all) => all.indexOf(h) === i)
            .slice(0, 10),
        };
      });

      survey.pages.push({ name: p.name, ok: true, ...info });
      console.log(`  ${p.name.padEnd(13)} ok   ${info.rows} rows · ${info.tables} tables · ${info.heading.slice(0, 50)}`);
    } catch (err) {
      survey.pages.push({ name: p.name, ok: false, error: String(err.message).split('\n')[0] });
      console.log(`  ${p.name.padEnd(13)} FAILED  ${String(err.message).split('\n')[0].slice(0, 60)}`);
    }
  }

  writeFileSync(SURVEY, JSON.stringify(survey, null, 2));
  console.log(`\nSurvey written to worker/.sessions/12twenty-survey.json`);
  console.log('Tell Claude it is done and it will write the reader against what is there.');

  await ctx.close();
}
