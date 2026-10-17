// Gmail — read only, and only four questions.
//
// This never sends, archives, labels or deletes. The scope is gmail.readonly
// and the code could not do otherwise; that is deliberate, not incidental.
//
// LinkedIn is read HERE and nowhere else. Scraping LinkedIn breaches their
// terms and risks your account, so roles and contacts arrive only as the
// alert emails LinkedIn itself sends you (spec §2).
//
// Scoring is rules, not a model. You have to be able to predict it and argue
// with it, so every item carries the reasons that got it there.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { markSource, googleRefreshToken } from './lib.mjs';
import { scoreRole, TARGETS } from './targets.mjs';
import { PROFILE } from './profile.mjs';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TOKEN_PATH = fileURLToPath(new URL('./.credentials/google-token.json', import.meta.url));
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

let cachedToken = null;
let cachedUntil = 0;

function readStoredScope() {
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf8')).scope ?? '';
  } catch {
    return null; // no file: running in the cloud, where scopes are not recorded
  }
}

async function accessToken(env) {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const refreshToken = googleRefreshToken(env);

  /**
   * The scope check applies only to a token read from the laptop's file,
   * which records the scopes it was granted.
   *
   * A token supplied to the cloud runner as a secret carries no such record,
   * so insisting on one would reject a perfectly good token. Google refuses
   * the Gmail call itself when the scope is missing, and that error names the
   * problem just as plainly.
   */
  const storedScope = readStoredScope();
  if (storedScope !== null && !/gmail\.readonly/.test(storedScope)) {
    throw new Error(
      'The stored Google token has no Gmail scope. Set GOOGLE_GMAIL_SCOPE=true in .env.local and re-run worker/google-auth.mjs',
    );
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tok = await res.json();
  if (!res.ok) {
    throw new Error(tok.error === 'invalid_grant'
      ? 'Google refresh token rejected — re-run "node worker/google-auth.mjs"'
      : `Google auth failed: ${tok.error_description || tok.error}`);
  }
  cachedToken = tok.access_token;
  cachedUntil = Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000;
  return cachedToken;
}

async function api(env, path) {
  const token = await accessToken(env);
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gmail ${res.status} ${res.statusText} — ${body.slice(0, 160)}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */

const LINKEDIN_JOBS = /jobalerts|jobs-(listings|noreply)|job-?alert/i;
// Only a person actually reaching out. `notifications-noreply` also carries
// digests about your own posts, which is not a contact — it was being filed as
// one ("<First name>, your posts got 1,024 impressions").
const LINKEDIN_SOCIAL = /invitations|inmail|messaging-digest/i;

/**
 * Companies whose recruiting mail earns a bonus, from lib/targets.json
 * (`companies`, optional — matched against the sender's domain as
 * `<name>.com`). Missing or empty means no company bonus.
 */
const TARGET_COMPANIES = (TARGETS.companies ?? []).map((c) => String(c).toLowerCase());

/**
 * Outlets whose mail counts as reading rather than correspondence. Matched on
 * the sender's domain, so "substack" in a subject line does not qualify.
 */
const NEWS_SENDERS = [
  'substack.com', 'theinformation.com', 'axios.com', 'morningbrew.com',
  'bloomberg.com', 'wsj.com', 'nytimes.com', 'ft.com', 'economist.com',
  'stratechery.com', 'hbr.org', 'businessinsider.com', 'techcrunch.com',
  'platformer.news', 'lennysnewsletter.com', 'reforge.com',
  'reuters.com', 'apnews.com', 'politico.com', 'semafor.com', 'theatlantic.com',
  'washingtonpost.com', 'npr.org', 'cnbc.com', 'theverge.com', 'arstechnica.com',
  'foreignaffairs.com', 'thedispatch.com', 'puck.news', 'sherwood.news',
];

/**
 * What counts as worth reading.
 *
 * Two kinds: what you are building towards professionally, and what you want
 * to be able to hold a conversation about — AI, tech, geopolitics and US
 * news. Edit the list to match your own interests.
 */
const INTERESTS = [
  // Career
  'strategy', 'product', 'marketing', 'operations', 'growth', 'pricing',
  'consumer', 'retail', 'logistics', 'marketplace', 'subscription',
  'internship', 'mba', 'recruiting',

  // AI
  'ai', 'artificial intelligence', 'openai', 'anthropic', 'llm', 'chatgpt',
  'claude', 'gemini', 'model', 'compute', 'chips', 'semiconductor', 'nvidia',

  // Tech
  'tech', 'startup', 'antitrust', 'regulation', 'ipo', 'acquisition',
  'layoffs', 'earnings', 'valuation', 'big tech', 'platform',

  // Geopolitics
  'china', 'taiwan', 'russia', 'ukraine', 'israel', 'gaza', 'iran',
  'tariff', 'trade war', 'sanctions', 'nato', 'eu', 'election',
  'immigration', 'visa', 'h-1b', 'supply chain',

  // US
  'fed', 'federal reserve', 'inflation', 'interest rate', 'recession',
  'congress', 'senate', 'supreme court', 'white house', 'shutdown',
  'unemployment', 'housing', 'jobs report',
];

const ACTION_WORDS = /\b(deadline|rsvp|respond|reply|due|required|confirm|sign ?up|register|apply by|action needed|final notice)\b/i;

const header = (msg, name) =>
  (msg.payload?.headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function parseFrom(raw) {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}

/**
 * Why this mail matters, as a list of reasons and a total.
 *
 * Every rule is worth stating out loud, because the rail shows them. Nothing
 * here looks at the body: subject, sender and labels are enough, and reading
 * bodies for scoring would be both slower and more intrusive than it needs.
 */
function scorePriority(msg, from, subject, labels) {
  const reasons = [];
  let score = 0;

  const domain = from.email.split('@')[1] ?? '';

  if (/(^|\.)(hbs\.edu|mba20\d\d\.hbs\.edu|harvard\.edu)$/i.test(domain)) {
    score += 3; reasons.push('From HBS');
  }
  if (labels.includes('UNREAD')) { score += 1; reasons.push('Unread'); }
  if (labels.includes('IMPORTANT')) { score += 2; reasons.push('Gmail marked it important'); }
  if (ACTION_WORDS.test(subject)) { score += 3; reasons.push('Subject asks for something'); }

  /**
   * A target company only counts when the mail is plausibly about a job.
   *
   * Matching the company name anywhere in the address scored "Thanks for being
   * a great guest" from Airbnb as a priority, and a newsletter whose domain
   * merely contained "meta". So: the domain must *be* the company's, and the
   * subject must look like recruiting.
   */
  const company = TARGET_COMPANIES.find((t) => domain === `${t}.com` || domain.endsWith(`.${t}.com`));
  if (company && /\b(intern|role|recruit|application|apply|opportunity|interview|offer)\b/i.test(subject)) {
    score += 3; reasons.push(`Recruiting mail from ${company}`);
  }

  if (labels.includes('CATEGORY_PROMOTIONS')) { score -= 5; reasons.push('Promotional'); }
  if (labels.includes('CATEGORY_SOCIAL')) { score -= 4; reasons.push('Social'); }
  if (labels.includes('CATEGORY_UPDATES') && !ACTION_WORDS.test(subject)) {
    score -= 2; reasons.push('Automated update');
  }
  if (/no-?reply|donotreply|newsletter|digest|notification|mailer|marketing|@e\./i.test(from.email)) {
    score -= 3; reasons.push('Automated sender');
  }
  // Calendar notifications duplicate what the calendar already shows.
  if (/calendar-notification@google\.com$/i.test(from.email)) {
    score -= 6; reasons.push('Calendar notification');
  }

  return { score, reasons };
}

/**
 * Roles out of a LinkedIn alert.
 *
 * LinkedIn's alert emails list each job as a link to /jobs/view/<id>. The link
 * text is the role title; the company follows it. This reads the plain-text
 * part where there is one, because the HTML is a table soup that changes
 * often and the text part does not.
 */
function rolesFromAlert(msg) {
  const html = decodeBody(msg.payload, 'text/html');
  if (!html) return [];

  /**
   * The single-job alert, read from the subject.
   *
   * LinkedIn sends two shapes. The digest lists several jobs as anchors, which
   * is what the regex below was written against. The single-job alert says
   * everything in its subject — "Waymo is hiring a Strategic Partnerships
   * Development Manager" — and lays the body out differently enough that the
   * anchor pattern matched nothing at all. Every alert in the mailbox over
   * ninety days was the second kind, so the parser had never produced a row.
   *
   * The subject is also the more durable source. LinkedIn's markup is table
   * soup that changes without notice; "X is hiring a Y" has not.
   */
  const single = /^(.+?)\s+is hiring\s+(?:a|an)\s+(.+?)\s*$/i.exec(
    (msg.payload.headers ?? []).find((h) => h.name === 'Subject')?.value ?? '',
  );
  if (single) {
    const company = strip(single[1]);
    const title = strip(single[2]);
    const url = (html.match(/https:\/\/[^"'\s]*jobs\/view\/[^"'\s]*/) ?? [])[0] ?? null;
    const { score, reasons } = scoreRole(title, '', company);
    return score > 0 ? [{ title, company, url, score, reasons }] : [];
  }

  const out = [];
  const seen = new Set();
  // Each job is an anchor to /jobs/view/. The anchor text is the title; the
  // company sits in the first <p> after it. Confirmed against a real alert
  // rather than inferred — the earlier version guessed and swapped the two.
  const re = /<a[^>]+href="([^"]*jobs\/view[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>([\s\S]{0,600}?)<\/p>/g;

  let m;
  while ((m = re.exec(html)) && out.length < 15) {
    const url = m[1].replace(/&amp;/g, '&');
    const title = strip(m[2]);
    // The company paragraph runs "Anthropic New York, NY (Hybrid)" — the
    // location is appended, not a separate element. The whole line is kept
    // for scoring (it is the only place the location appears) and the company
    // name is cut out of it for display.
    const companyLine = strip((m[3].match(/<p[^>]*>([\s\S]*)$/) ?? [])[1] ?? '');
    const company = companyLine
      .split(/\s+(?=(?:New York|San Francisco|Boston|Seattle|Chicago|Austin|London|Remote|United States|[A-Z][a-z]+,\s*[A-Z]{2}\b))/)[0]
      .trim();
    if (!title || title.length < 4) continue;
    if (/linkedin|unsubscribe|see all|view job/i.test(title)) continue;

    const key = `${title}|${company}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // The same scorer the job boards use, against lib/targets.json. Three
    // copies of these word lists used to live in three files, which is how
    // a role ruled out as a target survived here after it had been removed
    // everywhere else.
    const { score, reasons } = scoreRole(title, companyLine, company);

    out.push({ title, company, url, score, reasons });
  }
  return out.filter((r) => r.score > 0);
}

/**
 * A readable one-liner out of a Gmail snippet.
 *
 * Newsletters pad their preview text with zero-width joiners and hair spaces
 * so the inbox preview looks empty, and the snippet arrives HTML-escaped. Left
 * alone it read as "An interview with the ex-Google CEO ‌ ‌ ‌ ‌ ‌ ‌" and
 * "OpenAI&#39;s CEO", which is worse than no summary.
 */
function cleanSnippet(raw) {
  const entities = (raw ?? '')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;|&#\d+;/g, ' ');

  // Newsletters pad their preview text with zero-width joiners and hair spaces
  // so the inbox preview looks empty. Left in, a summary reads as
  // "An interview with the ex-Google CEO . . . . . ." — worse than none.
  const invisible = (c) =>
    c === 0x034f || c === 0x2800 || c === 0xfeff ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f);
  const thinSpace = (c) => c >= 0x2000 && c <= 0x200a;

  const text = [...entities]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (invisible(c)) return '';
      if (thinSpace(c)) return ' ';
      return ch;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 12) return null;
  if (text.length <= 240) return text;

  // Cut at a sentence or word boundary rather than mid-word.
  const cut = text.slice(0, 240);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${cut.slice(0, stop > 120 ? stop : 240).trim()}\u2026`;
}

const strip = (s) =>
  s.replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function decodeBody(part, mime) {
  if (!part) return '';
  if (part.mimeType === mime && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const p of part.parts ?? []) {
    const found = decodeBody(p, mime);
    if (found) return found;
  }
  return '';
}

/**
 * A first line for reaching out. Draft only — nothing sends it, and
 * EMAIL_SEND_ENABLED does not apply because no send path exists at all.
 *
 * Deliberately plain: a template that sounds like a template is better than
 * one pretending to be your voice and getting it slightly wrong.
 */
function draftOutreach(name, context) {
  const first = (name ?? '').split(/\s+/)[0] || 'there';
  const focus = (TARGETS.functions ?? []).slice(0, 2).map((f) => f.name.toLowerCase()).join(' and ') || 'new';
  const timing = TARGETS.timing ? ` for a ${TARGETS.timing.toLowerCase()}` : '';
  return `Hi ${first} — I'm ${PROFILE.firstName}, ${PROFILE.outreachIntro}. ${context} ` +
    `I'm focused on ${focus} roles${timing} and would value fifteen minutes ` +
    `to hear how you think about yours. Happy to work around your schedule.`;
}

/* ------------------------------------------------------------------ */

/**
 * What to fetch, and why it is not simply "recent mail".
 *
 * The sweep used to be the only query: the newest 60 messages of the last week.
 * A busy Gmail carries over 500 a week, so that is roughly the top twelve per cent
 * — and Gmail returns newest first, so everything else was invisible. LinkedIn
 * sent eleven job alerts in ninety days and the reader had never seen one of
 * them. LinkedIn looking "turned off" was this, not a setting on the account.
 *
 * Raising the cap is not the answer. Each message costs its own API call for
 * the body, so fetching 500 every twenty minutes is absurd. Asking precise
 * questions is cheap and, unlike the sweep, complete: there are only a handful
 * of LinkedIn alerts, and a query for them returns all of them.
 *
 * The sweep stays, capped, because the priority panel is about what is RECENT
 * and the newest sixty is a fair answer to that. These run beside it and catch
 * what it structurally cannot.
 */
const TARGETED = [
  // Role alerts. 14 days, because an alert you have not opened is still worth
  // surfacing and they arrive only a few times a week.
  { q: 'newer_than:14d from:jobs-noreply@linkedin.com', max: 25 },
  { q: 'newer_than:14d subject:("job alert" OR "jobs for you" OR "new jobs")', max: 25 },
  // Invitations, messages and the rest of LinkedIn's notifications.
  { q: 'newer_than:7d from:linkedin.com', max: 40 },
];

export async function syncGmail(sql, env, did, { days = 7, max = 60 } = {}) {
  let ids;
  try {
    const q = encodeURIComponent(`newer_than:${days}d -in:chats`);
    const list = await api(env, `/messages?q=${q}&maxResults=${max}`);
    ids = (list.messages ?? []).map((m) => m.id);

    // Union, deduped. A message caught by both the sweep and a targeted query
    // must be read once, not twice — it would otherwise be scored and inserted
    // a second time under the same source_id.
    const seenIds = new Set(ids);
    for (const t of TARGETED) {
      try {
        const extra = await api(env, `/messages?q=${encodeURIComponent(t.q)}&maxResults=${t.max}`);
        for (const m of extra.messages ?? []) {
          if (seenIds.has(m.id)) continue;
          seenIds.add(m.id);
          ids.push(m.id);
        }
      } catch {
        // One targeted query failing must not cost the whole pass — the sweep
        // is still worth having on its own.
      }
    }
  } catch (err) {
    await markSource(sql, 'gmail', false, err.message);
    did.push(`Gmail FAILED — ${err.message}`);
    return { ok: false, reason: err.message };
  }

  let priority = 0, roles = 0, contacts = 0, news = 0;
  const newsCandidates = [];

  /**
   * The reading panel is rebuilt twice a day, not every twenty minutes.
   *
   * Mail has to be read often for the priority list, but a set of headlines
   * that reshuffles while you are halfway down it is not something anyone can
   * finish. Twelve hours means roughly a morning edition and an evening one.
   */
  const [pref] = await sql`select news_refreshed_at from prefs where id = true`;
  const lastNews = pref?.news_refreshed_at ? Date.parse(pref.news_refreshed_at) : 0;
  const refreshNews = Date.now() - lastNews > 12 * 3600_000;

  for (const id of ids) {
    let msg;
    try {
      msg = await api(env, `/messages/${id}?format=full`);
    } catch {
      continue; // one unreadable message must not stop the pass
    }

    const labels = msg.labelIds ?? [];
    const subject = header(msg, 'Subject') || '(no subject)';
    const from = parseFrom(header(msg, 'From'));
    const received = new Date(Number(msg.internalDate ?? Date.now())).toISOString();
    const url = `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`;

    if (LINKEDIN_JOBS.test(from.email)) {
      for (const r of rolesFromAlert(msg)) {
        const res = await sql`
          insert into email_items (kind, source, gmail_id, thread_id, subject, from_name, from_email,
                                   snippet, url, reasons, score, received_at)
          values ('linkedin_role', 'gmail', ${`${id}:${r.title}`.slice(0, 200)}, ${msg.threadId},
                  ${r.title}, ${r.company}, ${from.email},
                  ${`${r.title} — ${r.company}`}, ${r.url ?? url}, ${r.reasons}, ${r.score}, ${received})
          on conflict (kind, source, gmail_id) do nothing
          returning id`;
        if (res.length) roles++;
      }
      continue;
    }

    if (LINKEDIN_SOCIAL.test(from.email)) {
      const who = subject.replace(/^(.*?)(has|is|sent|invited|wants).*$/i, '$1').trim();
      // A digest about your own activity is not someone to reply to.
      const aboutOwner = new RegExp(
        `^${escapeRe(PROFILE.firstName ?? '') || '(?!)'}[,\\s]|your (posts?|profile|activity|search)`,
        'i',
      ).test(subject);
      if (who && who.length < 60 && !aboutOwner) {
        const res = await sql`
          insert into email_items (kind, source, gmail_id, thread_id, subject, from_name, from_email,
                                   snippet, url, reasons, score, received_at, draft)
          values ('contact', 'gmail', ${id}, ${msg.threadId}, ${subject}, ${who}, ${from.email},
                  ${msg.snippet ?? null}, ${url}, ${['From LinkedIn']}, 1, ${received},
                  ${draftOutreach(who, 'We connected on LinkedIn.')})
          on conflict (kind, source, gmail_id) do nothing
          returning id`;
        if (res.length) contacts++;
      }
      continue;
    }

    // CPD writes as a person, not a robot — worth surfacing as a contact.
    if (/cpd|careers?@|advisor/i.test(from.email) && !/no-?reply/i.test(from.email)) {
      const res = await sql`
        insert into email_items (kind, source, gmail_id, thread_id, subject, from_name, from_email,
                                 snippet, url, reasons, score, received_at, draft)
        values ('contact', 'gmail', ${id}, ${msg.threadId}, ${subject}, ${from.name}, ${from.email},
                ${msg.snippet ?? null}, ${url}, ${['From CPD']}, 3, ${received},
                ${draftOutreach(from.name, 'Thank you for the note.')})
        on conflict (kind, source, gmail_id) do nothing
        returning id`;
      if (res.length) contacts++;
      continue;
    }

    /**
     * Industry reading you already subscribe to.
     *
     * Checked before the priority rules, because a newsletter would otherwise
     * be scored as mail wanting a reply and then buried for being automated.
     * Nothing is fetched from the open web — this is only what already arrives
     * in your inbox, filtered to what you are actually building towards.
     */
    const outlet = NEWS_SENDERS.find((n) => (from.email.split('@')[1] ?? '').includes(n));
    if (outlet) {
      // Gathered now, written at the end — the panel needs at least four
      // headlines, and that is only knowable once every candidate is in.
      const lower = subject.toLowerCase();
      const topic = INTERESTS.find((t) => lower.includes(t));
      const reasons = [outlet];
      let score = 1;
      if (topic) { score += 3; reasons.push(`About ${topic}`); }
      if (TARGET_COMPANIES.some((t) => lower.includes(t))) {
        score += 2; reasons.push('Names a target company');
      }
      newsCandidates.push({
        id, threadId: msg.threadId, subject, from, url, received, reasons, score,
        // Gmail's snippet is the publisher's own standfirst. A better summary
        // than anything inferable from a subject line, and not invented.
        tldr: cleanSnippet(msg.snippet),
      });
      continue;
    }

    const { score, reasons } = scorePriority(msg, from, subject, labels);
    if (score < 3) continue;

    const res = await sql`
      insert into email_items (kind, source, gmail_id, thread_id, subject, from_name, from_email,
                               snippet, url, reasons, score, received_at)
      values ('priority', 'gmail', ${id}, ${msg.threadId}, ${subject}, ${from.name}, ${from.email},
              ${msg.snippet ?? null}, ${url}, ${reasons}, ${score}, ${received})
      on conflict (kind, source, gmail_id) do update
        set score = excluded.score, reasons = excluded.reasons
      returning id`;
    if (res.length) priority++;
  }

  /**
   * At least four headlines.
   *
   * A strict topic match found one item in a week, and a panel with one thing
   * in it looks broken rather than quiet. So the best-scoring candidates fill
   * it, and if fewer than four cleared the topic bar the rest of the
   * newsletters make up the number — labelled honestly as unmatched rather
   * than dressed up as relevant.
   */
  if (refreshNews && newsCandidates.length) {
    const ranked = newsCandidates.sort((a, b) => b.score - a.score || Date.parse(b.received) - Date.parse(a.received));
    const matched = ranked.filter((c) => c.score > 1);
    const filler = ranked.filter((c) => c.score === 1).slice(0, Math.max(0, 4 - matched.length));
    for (const c of [...matched.slice(0, 8), ...filler]) {
      const reasons = c.score > 1 ? c.reasons : [...c.reasons, 'From your newsletters — no topic match'];
      const res = await sql`
        insert into email_items (kind, source, gmail_id, thread_id, subject, from_name, from_email,
                                 snippet, url, reasons, score, received_at, tldr)
        values ('news', 'gmail', ${c.id}, ${c.threadId}, ${c.subject}, ${c.from.name}, ${c.from.email},
                ${c.tldr}, ${c.url}, ${reasons}, ${c.score}, ${c.received}, ${c.tldr})
        on conflict (kind, source, gmail_id) do update set tldr = excluded.tldr, reasons = excluded.reasons
        returning (xmax = 0) as inserted`;
      if (res[0]?.inserted) news++;
    }
    await sql`update prefs set news_refreshed_at = now() where id = true`;
  }

  await markSource(sql, 'gmail', true);

  if (priority) did.push(`Gmail: ${priority} message${priority === 1 ? '' : 's'} worth a look`);
  if (roles) did.push(`Gmail: ${roles} LinkedIn role${roles === 1 ? '' : 's'} matching your filters`);
  if (contacts) did.push(`Gmail: ${contacts} contact${contacts === 1 ? '' : 's'} to reach out to`);
  if (news) did.push(`Gmail: ${news} thing${news === 1 ? '' : 's'} worth reading`);

  return { ok: true, read: ids.length, priority, roles, contacts, news };
}
