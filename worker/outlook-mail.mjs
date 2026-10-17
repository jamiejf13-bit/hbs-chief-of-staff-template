// HBS Outlook mail → email_items.
//
// Mail is often read in Gmail and ANSWERED in Outlook, so a Gmail-only view
// showed one half of every conversation and called it the whole thing: threads
// already dealt with sat in "Priority email" looking unanswered, and anything
// that only ever goes to the HBS address — registration confirmations, club
// mail, section logistics — was invisible.
//
// READ-ONLY, AND MORE CAREFULLY THAN USUAL. This reads the message LIST and
// nothing else. It never opens a message, because opening one marks it read in
// the real mailbox, and a tool that quietly clears your unread badge is worse
// than one that shows you nothing. Nothing is sent, filed, flagged or deleted.
//
// The list gives: sender display name, subject, a relative time and a snippet.
// It does NOT give the sender's address, so the domain rules the Gmail scorer
// leans on are not available here and this has its own.

import { chromium } from 'playwright';
import { PROFILE, clearStaleLocks } from './outlook.mjs';
import { markSource } from './lib.mjs';
import { PROFILE as OWNER } from './profile.mjs';
import { TARGETS } from './targets.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How often every folder is walked, as opposed to just the Inbox.
 *
 * Held in module scope rather than the database: it is a scheduling
 * detail, and losing it on a restart costs one extra full walk.
 */
const FULL_WALK_EVERY = 3 * 60 * 60_000;
let lastFullWalk = 0;

/**
 * A link to the message itself.
 *
 * Every row was given the inbox URL, so clicking "Priority email" opened
 * Outlook at the top of the mailbox and left you to find the thing you had
 * just clicked. The conversation id the list already exposes is enough to
 * address it directly.
 */
const messageUrl = (convid) =>
  `https://outlook.cloud.microsoft/mail/0/id/${encodeURIComponent(convid)}`;

const MAIL = 'https://outlook.cloud.microsoft/mail/0/';

/** Subjects that are asking you for something rather than telling you. */
const ACTION_WORDS =
  /\b(deadline|rsvp|respond|reply|due|required|confirm|sign ?up|register|apply by|action needed|final notice|reminder)\b/i;

/**
 * Kinds of mail that never need you, whatever else they score.
 *
 * These are exclusions rather than penalties: a penalty still lets something
 * climb back on a strong enough subject, and the point of these is that the
 * whole category has been judged noise. Each carries the reason, so the
 * panel can say what it is suppressing rather than the mail simply vanishing.
 *
 * NOTE on event changes: this also drops postponements and cancellations of
 * sessions you have registered for. That is deliberate and it is a real
 * trade — the 12Twenty reader and the calendar mirror are what tell you a
 * registered event moved, not this.
 */
const IGNORED = [
  [/\b(notification of changes?|date change|time change|room change|location change|rescheduled|postponed|cancell?ed|updated invitation)\b/i,
    'An event change notice'],
  [/student event calendar|mbaeventcalendar|events? calendar|daily digest|weekly digest/i,
    'The student event calendar'],
  [/\b(newsletter|working knowledge|briefing|bulletin|this week at|roundup|digest|the 10-point|highlights)\b/i,
    'News and bulletins'],

  /**
   * Employers you are not recruiting with (exclude.employers in
   * lib/targets.json). An approach from one is not a near miss — it is the
   * wrong industry, and such mail was ranking top of the list. Same pattern
   * shape as people.mjs; '(?!)' keeps an empty list from matching everything.
   */
  [new RegExp(`\\b(${TARGETS.exclude.employers.join('|') || '(?!)'})(?!\\w)`, 'i'),
    'An employer you are not targeting'],

  /**
   * A reminder is about something already known about. The first notice
   * is the one worth surfacing; the chasers are not, and HBS sends several
   * per event.
   */
  [/\b(reminder|final reminder|last call|don'?t forget|closing (soon|tonight)|still time)\b/i,
    'A reminder about something already announced'],

  /**
   * Administrative traffic and course announcements with nothing to do.
   * Admin and news are ignored; class mail splits into things to DO and
   * summaries of what has already happened, and only the first matters.
   */
  [/\b(password|harvardkey|security report|fire safety|timely warning|my responses|receipt|payment link|policy|facilities)\b/i,
    'Administrative'],
  [/\b(assignment graded|grades? (are )?(posted|available)|module \d+ wrap|models for|now available|is live|posted to canvas)\b/i,
    'A course announcement, nothing to do'],
];

/**
 * An open action: the one thing that makes a message worth your morning.
 *
 * This is the test, not the category. "Weekend Sprints: Interest Poll Open"
 * is a club email and should surface because there is a poll to fill in;
 * "Final Reminder | Retail and Luxury Goods Club" is also a club email and
 * should not, because it is a chaser for something already announced.
 *
 * Checked AFTER the ignore rules, so a reminder to register still loses.
 */
const OPEN_ACTION =
  // `register` does not match "Registration" — the words diverge at
  // "registe" against "registra" — so a club trek email, whose subject
  // ended "Details & Registration", was read as having nothing to do. Prefix
  // matching, not whole words, for the ones that inflect.
  /\b(regist(er|ration)|sign ?up|signup|rsvp|poll|apply|applicat(e|ion)|submit|complete (the|this)|fill out|interest (form|poll)|save your spot|spots? available|tickets?|deadline to|due by)/i;

/** Older than this and it is history, not something waiting on you. */
const MAX_AGE_DAYS = 5;

/**
 * Should this message be left out entirely?
 *
 * Returns the reason when it should, so the caller can count what it dropped
 * and the panel can say so — a filter that works silently is one you cannot
 * argue with, and this ranking has needed correcting more than once.
 */
export function ignoreReason({ sender, subject, snippet, received, repliedTo }, now = new Date()) {
  const text = `${sender} ${subject}`;
  const hasAction = OPEN_ACTION.test(`${subject} ${snippet ?? ''}`);

  /**
   * Already answered — unless answering was not the action.
   *
   * Your replies live in Sent Items and Outlook gives every message in a
   * thread the same conversation id, so a thread you have written into is one
   * you have dealt with. That is the strongest signal in the mailbox and
   * nothing was using it.
   *
   * But replying is not registering. A reply in a trek thread asking when
   * tickets go on sale is not the same as registering — and this rule once
   * buried the one item that actually mattered. A thread carrying a sign-up,
   * a poll or a ticket survives your reply, because the conversation and the
   * action are different things.
   */
  if (repliedTo && !hasAction) return 'You have already replied';

  for (const [re, why] of IGNORED) {
    if (re.test(text)) return why;
  }

  if (received) {
    const age = (now.getTime() - new Date(received).getTime()) / 86_400_000;
    if (age > MAX_AGE_DAYS) return `Older than ${MAX_AGE_DAYS} days`;
  }

  /**
   * Nothing to do. After the exclusions, a message earns its place by asking
   * for an action not yet taken — registering, signing up, a poll, an
   * application, a form. Everything else is reading.
   */
  if (!hasAction) return 'Nothing to action';

  return null;
}

/**
 * Senders that are a list, not a person.
 *
 * HBS runs a lot of these and they dominate the inbox by volume. They are not
 * noise — the Student Event Calendar is genuinely useful — but they are never
 * waiting on a reply, which is what this panel is for.
 */
const BULK_SENDER =
  /(daily digest|newsletter|no-?reply|do-?not-?reply|working knowledge|event calendar|announce|bulletin|notification)/i;

/** Recruiting language, since the domain rules are not available here. */
const RECRUITING =
  /\b(intern|internship|recruit|application|apply|interview|offer|career|coffee chat|info ?session|fireside)\b/i;

/**
 * Turn Outlook's relative time into an instant.
 *
 *   "7:03 PM"        today
 *   "Tue 5:09 PM"    the most recent Tuesday
 *   "9/18/2026"      an explicit date
 *
 * Anything unrecognised returns null and the row is skipped rather than
 * guessed at — a message filed under the wrong day is worse than one missing.
 */
export function parseWhen(raw, now = new Date()) {
  const s = (raw ?? '').trim();

  const today = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (today) {
    const d = new Date(now);
    d.setHours(hour24(today[1], today[3]), Number(today[2]), 0, 0);
    // A time later than now must belong to yesterday.
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }

  const weekday = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (weekday) {
    const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      .indexOf(weekday[1].toLowerCase().slice(0, 3));
    const d = new Date(now);
    d.setHours(hour24(weekday[2], weekday[4]), Number(weekday[3]), 0, 0);
    // Walk back to that weekday; at most seven days, never forward.
    let guard = 0;
    while (d.getDay() !== want && guard++ < 8) d.setDate(d.getDate() - 1);
    if (d > now) d.setDate(d.getDate() - 7);
    return d;
  }

  const dated = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (dated) return new Date(Number(dated[3]), Number(dated[1]) - 1, Number(dated[2]), 12, 0, 0, 0);

  /**
   * "Fri 9/25" — anything older than about a week loses its time and gains a
   * weekday. Outlook uses at least four shapes in one list and this was the
   * one that mattered: it is every message beyond the last few days.
   *
   * The year is not given. Assume the most recent one that is not in the
   * future, which is right except for mail more than a year old — and this
   * only ever reads the top of the inbox.
   */
  const shortDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})\/(\d{1,2})$/i.exec(s);
  if (shortDate) {
    const month = Number(shortDate[1]) - 1;
    const day = Number(shortDate[2]);
    let d = new Date(now.getFullYear(), month, day, 12, 0, 0, 0);
    if (d > now) d = new Date(now.getFullYear() - 1, month, day, 12, 0, 0, 0);
    return d;
  }

  return null;
}

/** Does this field look like Outlook's "when" column? */
const LOOKS_LIKE_WHEN = (s) =>
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)$/i.test(s)
  || /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*)?\d{1,2}\/\d{1,2}(?:\/\d{4})?$/i.test(s);

function hour24(h, ampm) {
  let n = Number(h) % 12;
  if (/pm/i.test(ampm)) n += 12;
  return n;
}

/**
 * Split one row's visible lines into fields.
 *
 * The shape is [avatar?, sender, subject, time, snippet]. The avatar is one or
 * two initials and is sometimes an empty string instead; some rows prefix the
 * sender with "Email from", which is the accessibility label leaking into the
 * visible text.
 */
export function parseRow(lines) {
  const parts = lines
    /**
     * Strip leading non-printing characters, then drop anything with no
     * letters or digits left.
     *
     * `l !== ''` is not enough: the avatar field often holds an invisible
     * glyph rather than an empty string, so it survived the filter and shifted
     * every field after it by one. The one email that actually needed acting
     * on came out with an empty sender and the sender's name as its subject,
     * and was dropped as having nothing to action.
     *
     * This is the second time an invisible character in this list has caused a
     * silent misread; the folder names did the same thing.
     */
    .map((l) => l.replace(/^[^\p{L}\p{N}]+/u, '').trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l))
    // A thread of several messages shows its count as a field of its own —
    // "(3)" — which shifted every position after it too.
    .filter((l) => !/^\(\d+\)$/.test(l))
    // The avatar proper: one or two initials on their own.
    .filter((l, i) => !(i === 0 && /^[A-Z]{1,2}$/.test(l)));

  if (parts.length < 3) return null;

  /**
   * Find the time column by shape, not by position.
   *
   * Everything before it is sender then subject; everything after is the
   * preview. That holds whatever optional badges Outlook decides to add,
   * which counting fields from the left does not.
   */
  const at = parts.findIndex(LOOKS_LIKE_WHEN);
  if (at < 2) return null;

  const sender = parts[0].replace(/^Email from\s+/i, '').trim();
  const subject = parts.slice(1, at).join(' ').trim();
  const received = parseWhen(parts[at]);
  if (!sender || !subject || !received) return null;

  return { sender, subject, received, snippet: parts.slice(at + 1).join(' ').trim() || null };
}

/**
 * How much a folder says about what is in it.
 *
 * Folders filed by hand make the folder the best signal in the mailbox —
 * better than anything a scorer can infer from a subject line. Recruiting
 * and the people you are building relationships with rank up; reading and
 * social rank down, because they are not waiting on you.
 */
/**
 * Your filing IS your triage.
 *
 * This had it backwards. It read the folder as a statement about IMPORTANCE —
 * Career & Recruiting worth +3, News & Research worth −3 — and so ranked a
 * recruiting email already read, filed and answered above an unread one
 * still sitting in the inbox.
 *
 * What a folder actually says is that you have been through it. So:
 *
 *   filed + read    you have dealt with it. Gone.
 *   filed + unread  filed by a rule, not by you. Still pending.
 *   unfiled         pending, whether or not you have opened it. Opening a
 *                   message on a phone at 7am is not the same as acting on it.
 *
 * Which folder it is no longer changes the score at all. It was the wrong
 * question: the folder tells you about the owner, not about the message.
 */
export function scoreOutlook({ sender, subject, snippet, unread, folder }) {
  const reasons = [];
  let score = 0;

  const filed = Boolean(folder) && !/^inbox$/i.test(folder);
  const text = `${subject} ${snippet ?? ''}`;

  /**
   * Unknown read state means old, not unread.
   *
   * This was the other way round at first, on the reasoning that retiring
   * mail nobody had looked at would be worse than keeping it. But the reader
   * now walks 28 folders and 379 messages every three hours, so anything
   * current is seen and given a read state on every pass. A row still
   * carrying no read state is one the walk no longer reaches — old, and
   * almost certainly dealt with. Ninety-three of them were sitting in the
   * panel collecting an "unread" bonus none of them had earned.
   */
  const isUnread = unread === true;

  if (filed && !isUnread) {
    return { score: -10, reasons: [`Filed under ${folder} and read — you have dealt with it`] };
  }

  if (!filed) { score += 3; reasons.push('Still in your inbox'); }
  if (isUnread) { score += 2; reasons.push('Unread'); }

  /**
   * Asking for something is the strongest signal there is, and it counts
   * double when it has not been filed: it was opened, it wants a reply, and
   * it has not been moved anywhere. That is the definition of outstanding.
   */
  const asks = ACTION_WORDS.test(text);
  if (asks) {
    score += 3;
    reasons.push('Asks for a reply, RSVP, form or deadline');
    if (!filed) { score += 2; reasons.push('Unfiled and waiting on you'); }
  }

  if (BULK_SENDER.test(sender) || BULK_SENDER.test(subject)) {
    score -= 4; reasons.push('Bulk mail, not addressed to you');
  } else if (/,/.test(sender) || /^\S+\s+\S+$/.test(sender)) {
    // A display name with a comma or two words is a person: "Example, Pat".
    score += 2; reasons.push('From a person');
  }

  if (RECRUITING.test(text)) { score += 2; reasons.push('Recruiting'); }

  // A confirmation records something already settled.
  if (/\b(confirmation|confirmed|receipt|registered)\b/i.test(subject) && !asks) {
    score -= 2; reasons.push('A confirmation, nothing to do');
  }

  return { score, reasons };
}

export async function syncOutlookMail(sql, env, did, { minScore = 3, keep = 120 } = {}) {
  clearStaleLocks();

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      viewport: { width: 1500, height: 1400 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch (err) {
    await markSource(sql, 'outlook-mail', false, `browser failed to launch: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(MAIL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(9000);

    if (/login\.microsoftonline|\/auth\//i.test(page.url())) {
      const why = 'Signed out — run "node worker/outlook-login.mjs" to sign in again';
      await markSource(sql, 'outlook-mail', false, why);
      did.push(`Outlook mail FAILED — ${why}`);
      return { ok: false, reason: why };
    }

    /**
     * Read every folder mail is filed into, not just the Inbox.
     *
     * Mail rules typically move most mail out of the Inbox on arrival — Career &
     * Recruiting with Coaches, Events, Networking and Speakers under it, a
     * folder per course, one per club. Reading only the Inbox therefore
     * missed the recruiting mail entirely, which was the whole reason for
     * reading Outlook at all.
     *
     * The tree exposes no links or ids, only clickable rows, so each folder
     * is opened by clicking its name.
     */
    const folders = await page.evaluate(() =>
      [...document.querySelectorAll('[role="treeitem"]')]
        .map((el) => (el.innerText ?? '').replace(/\s+/g, ' ').trim())
        // Strip the unread/item counts Outlook appends to the label.
        .map((t) => t.replace(/\s*(\d+ unread|\[\d+\] items?|selected)\s*/gi, '').trim())
        /**
         * Every label begins with an icon glyph that trim() does not remove,
         * because it is not whitespace. It left names like " Sent Items",
         * which matched neither the skip list — anchored with ^ — nor
         * Playwright's substring search, so the reader silently read only the
         * Inbox and reported success. Cut to the first letter or digit.
         */
        .map((t) => t.replace(/^[^\p{L}\p{N}]+/u, '').trim())
        .filter(Boolean));

    /**
     * Folders that are not incoming mail, or are your own outbound.
     *
     * Deleted and Junk are excluded because surfacing something you threw
     * away is worse than missing it. Sent and Drafts are your own writing.
     * The mailbox root (labelled with your address) and Favorites are
     * containers, not folders.
     */
    const mailboxRoot = escapeRe(String(OWNER.emails?.school ?? '').split('@')[0].toLowerCase());
    const SKIP = new RegExp(
      `^(sent items|drafts|deleted items|junk email|junk|outbox|conversation history|rss|notes|favorites|archive|${mailboxRoot ? `${mailboxRoot}@|` : ''}scheduled|search folders)`,
      'i',
    );
    const wanted = [...new Set(folders)].filter((f) => !SKIP.test(f));

    /** Harvest the list currently on screen, wheeling to page more of it in. */
    const harvestList = async (wheels) => {
      const found = new Map();
      const grab = async () => {
        for (const r of await page.evaluate(() => [...document.querySelectorAll('div[data-convid]')].map((el) => ({
          convid: el.getAttribute('data-convid'),
          unread: /^\s*Unread/i.test(el.getAttribute('aria-label') ?? ''),
          lines: (el.innerText ?? '').split('\n').map((x) => x.trim()),
        })))) {
          if (r.convid && !found.has(r.convid)) found.set(r.convid, r);
        }
      };
      await grab();
      const first = await page.locator('div[data-convid]').first().boundingBox().catch(() => null);
      if (!first) return [...found.values()];
      for (let i = 0; i < wheels && found.size < keep; i++) {
        const before = found.size;
        await page.mouse.move(first.x + first.width / 2, first.y + 300);
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(1000);
        await grab();
        // A fetch in flight looks exactly like the end of the list, so give
        // it a few tries before believing it.
        if (found.size === before && i > 4) break;
      }
      return [...found.values()];
    };

    /**
     * Which threads have you already answered?
     *
     * Your replies are in Sent Items, and Outlook gives every message in a
     * thread the same conversation id — so a thread with one of your own
     * messages in it is one you have dealt with. This is the strongest
     * signal in the mailbox and nothing was using it, which is why the
     * panel kept showing coffee chats arranged days ago.
     *
     * Read first, before anything else, because every later decision
     * depends on it. A failure here is not fatal: the set is simply empty
     * and the pass behaves as it did before.
     */
    const replied = new Set();
    try {
      const sent = page.locator('[role="treeitem"]').filter({ hasText: 'Sent Items' }).first();
      if (await sent.count()) {
        await sent.click({ timeout: 10_000 });
        await page.waitForTimeout(3000);
        for (const r of await harvestList(8)) replied.add(r.convid);
      }
    } catch { /* an unreadable Sent folder must not stop the inbox */ }

    let added = 0, seen = 0, readTotal = 0;
    const skipped = {};
    const perFolder = [];

    /**
     * The full walk is expensive: 29 folders, 371 messages, five minutes.
     * Run every twenty it would hold the browser profile for a quarter of
     * the time and collide with the calendar sync, which needs the same
     * one. The Inbox is what moves hour to hour; a folder is where mail
     * has already been filed, so it can wait.
     */
    const fullWalk = Date.now() - lastFullWalk > FULL_WALK_EVERY;
    const toRead = fullWalk
      ? ['Inbox', ...wanted.filter((f) => !/^inbox$/i.test(f))]
      : ['Inbox'];
    if (fullWalk) lastFullWalk = Date.now();

    for (const folder of toRead) {
      try {
        // Matched as a plain string, not a built regex. A folder called
        // "News & Research" or "Entertainment & Media" has to be escaped to
        // go into a pattern, and every layer between here and the file has
        // eaten a backslash at some point today. Playwright's hasText takes
        // a string and does the substring match itself.
        const item = page.locator('[role="treeitem"]')
          .filter({ hasText: folder })
          .first();
        if (!(await item.count())) continue;
        await item.click({ timeout: 10_000 });
        await page.waitForTimeout(2500);
      } catch {
        continue; // a folder that will not open is not worth failing the run
      }

      // The Inbox is the one worth reading deeply; the rest are filed and
      // only the recent end of each matters.
      const rows = await harvestList(/^inbox$/i.test(folder) ? 30 : 6);
      readTotal += rows.length;
      if (rows.length) perFolder.push(`${folder}:${rows.length}`);

      for (const row of rows) {
        const parsed = parseRow(row.lines);
        if (!parsed) continue;
        seen++;

        // Whole categories ruled out, checked before scoring so a
        // strong subject line cannot carry one back in.
        const ignored = ignoreReason({
          ...parsed,
          received: parsed.received,
          repliedTo: replied.has(row.convid),
        });
        if (ignored) { skipped[ignored] = (skipped[ignored] ?? 0) + 1; continue; }

        const { score, reasons } = scoreOutlook({ ...parsed, unread: row.unread, folder });
        if (score < minScore) continue;

        const res = await sql`
          insert into email_items (kind, source, gmail_id, subject, from_name,
                                   snippet, url, reasons, score, received_at, folder, unread)
          values ('priority', 'outlook', ${row.convid.slice(0, 200)}, ${parsed.subject},
                  ${parsed.sender}, ${parsed.snippet}, ${messageUrl(row.convid)},
                  ${reasons}, ${score}, ${parsed.received.toISOString()}, ${folder}, ${row.unread})
          /**
           * Read state and folder are refreshed on every pass, because both
           * change after the row was written — you open something, you file
           * something — and those two facts are now what decides whether it
           * still wants you. An insert-only row would answer with the state of
           * the mailbox at the moment it was first seen.
           *
           * not_relevant is never touched here: that one is the owner's.
           */
          on conflict (kind, source, gmail_id) do update
            set score = excluded.score, reasons = excluded.reasons,
                subject = excluded.subject, snippet = excluded.snippet,
                folder = excluded.folder, url = excluded.url,
                unread = excluded.unread
          returning (xmax = 0) as inserted`;
        if (res[0]?.inserted) added++;
      }
    }

    /**
     * Rescore what is already stored, and retire what no longer qualifies.
     *
     * The loop above skips a low score before it reaches the upsert, so a row
     * stored under older rules keeps that score for ever — which means
     * tightening the rules changes nothing for anything already in the table.
     * When filing became the triage signal, 141 rows stayed exactly where
     * they were: every one of them had been written under the old scoring and
     * none was ever revisited.
     *
     * Everything needed is on the row — sender, subject, snippet, unread,
     * folder — so this re-asks the same question of the stored copy.
     * `not_relevant` rows are left alone; that judgement is the owner's, not
     * the scorer's.
     */
    let retired = 0, rescored = 0;
    for (const row of await sql`
      select id, from_name, subject, snippet, unread, folder, score, received_at
        from email_items
       where source = 'outlook' and not not_relevant`) {
      // Stored rows get the exclusions too. Otherwise everything written
      // before a rule existed outlives it, which is exactly how 141 rows
      // survived the last change to this scoring.
      const ignoredNow = ignoreReason({
        sender: row.from_name ?? '',
        subject: row.subject,
        snippet: row.snippet,
        received: row.received_at,
      });

      const { score, reasons } = scoreOutlook({
        sender: row.from_name ?? '',
        subject: row.subject,
        snippet: row.snippet,
        unread: row.unread,
        folder: row.folder,
      });
      if (ignoredNow || score < minScore) {
        await sql`delete from email_items where id = ${row.id}`;
        retired++;
      } else if (score !== row.score) {
        await sql`update email_items set score = ${score}, reasons = ${reasons} where id = ${row.id}`;
        rescored++;
      }
    }
    if (retired) {
      did.push(`Outlook mail: ${retired} message${retired === 1 ? '' : 's'} you have filed or dealt with, cleared`);
    }

    if (!readTotal) {
      const why = 'No messages readable — the mail list did not render';
      await markSource(sql, 'outlook-mail', false, why);
      did.push(`Outlook mail FAILED — ${why}`);
      return { ok: false, reason: why };
    }

    await markSource(sql, 'outlook-mail', true);
    if (added) did.push(`Outlook mail: ${added} message${added === 1 ? '' : 's'} worth a look`);
    if (replied.size) did.push('Outlook mail: ' + replied.size + ' threads you have already replied to');
    const left = Object.entries(skipped).sort((a, b) => b[1] - a[1]);
    if (left.length) {
      const parts = left.map(([why, n]) => n + " " + why.toLowerCase());
      did.push("Outlook mail: left out " + parts.join(", "));
    }
    return { ok: true, read: readTotal, parsed: seen, added, retired, rescored, folders: perFolder.length, perFolder };
  } catch (err) {
    await markSource(sql, 'outlook-mail', false, err.message);
    did.push(`Outlook mail FAILED — ${String(err.message).slice(0, 160)}`);
    return { ok: false, reason: err.message };
  } finally {
    await ctx.close().catch(() => {});
  }
}
