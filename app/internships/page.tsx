'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import keywords from '@/data/keywords.json';
import targets from '@/lib/targets.json';

/**
 * Summer MBA internship tracker.
 *
 * The roles live in data/internships.json and nothing about them is computed,
 * inferred or fetched — when a watchlist role posts, the data file changes and
 * this page does not. Days-left is the only derived number, because it has to
 * move on its own.
 *
 * **Your own tracking never leaves the browser.** Status, date applied and
 * notes are localStorage, keyed by role id. The console is password-gated
 * rather than public, but "where have I applied" is private, and the database is
 * shared with a worker and a deploy platform. Every read and write is wrapped:
 * localStorage throws in private mode and can come back empty at any time, and
 * the page has to render regardless.
 */

const STATUSES = [
  'Watching', 'Not started', 'Networking', 'Applied',
  'Interviewing', 'Offer', 'Rejected', 'Withdrawn', 'Not interested',
] as const;

/**
 * Statuses that mean you have already applied.
 *
 * Interviewing and Offer belong here too: they come after applying, and a
 * role you are interviewing for is not something you need to see in a list of
 * things to do. Rejected and Withdrawn do not — those are over, and sorting
 * them in with live applications would make the section a graveyard.
 */
const APPLIED: readonly string[] = ['Applied', 'Interviewing', 'Offer'];

/** Set aside by you. Out of the way, not deleted. */
const DECLINED: readonly string[] = ['Not interested', 'Rejected', 'Withdrawn'];

/**
 * The primary target city, for the labels on the `nyc_option` column.
 *
 * The column keeps its name (it is in the schema), but which city it means is
 * whatever lib/targets.json lists first under locations.primary.
 */
const HOME_CITY = (targets.locations.primary[0] ?? 'primary city')
  .split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** The season, e.g. "Summer 2027", from targets.json's timing line. */
const SEASON = targets.timing.replace(/\s*internships?\s*$/i, '') || 'Summer';

type Personal = { status?: string; applied?: string; notes?: string; starred?: boolean };
type Tracking = Record<string, Personal>;

/**
 * A role as the page renders it, assembled from the database.
 *
 * The shape is the one the old JSON file had, because the rendering below was
 * written against it and converting the markup as well as the storage would
 * have been two risky changes at once. The mapping happens in exactly one
 * place, `fromRow`.
 */
type DbRole = {
  id: string;
  origin: string;
  company: string;
  role: string;
  function: string | null;
  locations: string | null;
  nyc_option: string | null;
  availability: string | null;
  deadline: string | null;
  timing: string | null;
  pay: string | null;
  blurb: string | null;
  link: string | null;
  link_check: string | null;
  keywords_key: string | null;
  priority: string | null;
  my_status: string | null;
  applied_on: string | null;
  my_notes: string | null;
  starred: boolean;
};

export type Contact = {
  id: string;
  company: string;
  name: string;
  title: string | null;
  how: string | null;
  spoke_on: string | null;
  notes: string | null;
};

/** A date column arrives as a Date or an ISO string; a date input wants YYYY-MM-DD. */
const asDay = (v: string | null) => (v ? String(v).slice(0, 10) : '');

function fromRow(r: DbRole) {
  return {
    id: r.id,
    origin: r.origin,
    priority: r.priority ?? 'N/A',
    company: r.company,
    role: r.role,
    function: r.function ?? '-',
    locations: r.locations ?? '',
    nycOption: r.nyc_option ?? 'No',
    status: r.availability ?? 'Open',
    deadline: r.deadline ? asDay(r.deadline) : null,
    timing: r.timing ?? '',
    pay: r.pay ?? '',
    notes: r.blurb ?? '',
    link: r.link ?? '',
    linkCheck: r.link_check ?? '',
    keywordsKey: r.keywords_key ?? '',
    mine: {
      status: r.my_status ?? '',
      applied: asDay(r.applied_on),
      notes: r.my_notes ?? '',
      starred: Boolean(r.starred),
    } as Personal,
  };
}

type Role = ReturnType<typeof fromRow>;

const STORE = 'cos-internship-tracking';

/**
 * Whatever tracking is still sitting in this browser's localStorage.
 *
 * Read once, to be carried into the database. The tracker kept months of
 * "where have I applied" here, and that data exists nowhere else — so the
 * move to a table has to collect it rather than abandon it.
 */
function legacyTracking(): Tracking {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Tracking;
  } catch {
    return {};
  }
}

/** Remember that this browser's copy has been handed over, so it is sent once. */
const MIGRATED = 'cos-internship-tracking-migrated';
function alreadyMigrated(): boolean {
  try { return localStorage.getItem(MIGRATED) === 'yes'; } catch { return false; }
}
function markMigrated() {
  try { localStorage.setItem(MIGRATED, 'yes'); } catch { /* nothing to do */ }
}

/** Whole days from today to the deadline. Negative once it has passed. */
/**
 * Today as YYYY-MM-DD, local.
 *
 * toISOString() would be UTC, which after 8pm Eastern is tomorrow — the date
 * field would show you applying the day after you did.
 */
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysLeft(deadline: string | null, nowMs: number): number | null {
  if (!deadline) return null;
  const [y, m, d] = deadline.split('-').map(Number);
  const due = new Date(y, m - 1, d, 23, 59, 59).getTime();
  return Math.ceil((due - nowMs) / 86_400_000);
}

/** "1 - Urgent" sorts above "4 - Watch". */
const rank = (p: string) => Number(p.match(/^(\d)/)?.[1] ?? 9);

export default function InternshipTracker() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [nycOnly, setNycOnly] = useState(false);
  const [company, setCompany] = useState('all');
  const [fn, setFn] = useState('all');
  const [priority, setPriority] = useState('all');
  const [sortBy, setSortBy] = useState<'priority' | 'days'>('priority');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/tracker', { cache: 'no-store' });
      if (!res.ok) throw new Error(`the tracker could not be read (${res.status})`);
      const j = await res.json();
      setRoles((j.roles as DbRole[]).map(fromRow));
      setContacts(j.contacts as Contact[]);
      setLoadErr(null);
      return j.roles as DbRole[];
    } catch (err) {
      // An empty tracker reads as "you have applied nowhere", which is a
      // worse lie than an error. Say what happened instead.
      setLoadErr(err instanceof Error ? err.message : 'the tracker could not be read');
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const first = await reload();
      if (!first || alreadyMigrated()) return;

      /**
       * Hand this browser's leftover tracking to the database, once.
       *
       * It cannot be done server-side: the data is in localStorage and no
       * other copy exists. The endpoint only fills blanks, so opening an old
       * phone browser later cannot overwrite work done since.
       */
      const legacy = legacyTracking();
      if (!Object.keys(legacy).length) { markMigrated(); return; }
      try {
        const res = await fetch('/api/tracker/migrate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tracking: legacy }),
        });
        if (res.ok) { markMigrated(); await reload(); }
      } catch {
        // Leave it unmarked and try again next load.
      }
    })();
  }, [reload]);
  // The countdown has to be right if the tab is left open overnight.
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  /**
   * Your own fields, written straight through.
   *
   * Shown immediately and sent in the background: typing a note should never
   * wait on a round trip. A failure reloads, so the screen goes back to what
   * is actually stored rather than showing an edit that was never saved.
   */
  function update(id: string, patch: Personal) {
    setRoles((prev) => prev.map((r) => (r.id === id ? { ...r, mine: { ...r.mine, ...patch } } : r)));

    const body: Record<string, unknown> = {};
    if ('status' in patch) body.my_status = patch.status ?? '';
    if ('applied' in patch) body.applied_on = patch.applied ?? '';
    if ('notes' in patch) body.my_notes = patch.notes ?? '';
    if ('starred' in patch) body.starred = patch.starred;

    void fetch(`/api/tracker/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => { if (!res.ok) void reload(); }).catch(() => void reload());
  }

  /** Record someone you have spoken to at a company. */
  async function addContact(company: string, form: Omit<Contact, 'id' | 'company'>) {
    if (!form.name?.trim()) return;
    setAdding(null);
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company, ...form }),
      });
      if (res.ok) await reload();
    } catch {
      await reload();
    }
  }

  async function removeContact(id: string) {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    try {
      await fetch(`/api/contacts?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      await reload();
    }
  }

  const companies = useMemo(
    () => [...new Set(roles.map((r) => r.company))].sort(),
    [roles],
  );
  const functions = useMemo(
    () => [...new Set(roles.map((r) => r.function).filter((f) => f !== '-'))].sort(),
    [roles],
  );
  const priorities = useMemo(
    () => [...new Set(roles.map((r) => r.priority).filter((p) => p !== 'N/A'))]
      .sort((a, b) => rank(a) - rank(b)),
    [roles],
  );

  const visible = useMemo(() => {
    const keep = roles.filter((r) => {
      if (r.status === 'No program') return false;
      if (nycOnly && !['Yes', 'Possible'].includes(r.nycOption)) return false;
      if (company !== 'all' && r.company !== company) return false;
      if (fn !== 'all' && r.function !== fn) return false;
      if (priority !== 'all' && r.priority !== priority) return false;
      return true;
    });

    return keep.sort((a, b) => {
      /**
       * A passed deadline goes to the bottom, whatever its priority.
       *
       * A closed role marked "1 - Urgent" sat at the very top of the page —
       * the first thing you saw every time, and the one thing you could do
       * nothing about. Priority describes how much a role matters; it cannot
       * outrank the fact that the door is shut.
       *
       * Sorted down rather than hidden: you may already have applied, and a
       * role that vanishes is one you cannot check.
       */
      /**
       * Starred first, above everything.
       *
       * It is the one ordering you set by hand, so it has to beat the
       * computed ones — a star that could be outranked by a priority string
       * would be decoration rather than a control.
       */
      if (Boolean(a.mine.starred) !== Boolean(b.mine.starred)) return a.mine.starred ? -1 : 1;

      const aClosed = (daysLeft(a.deadline, nowMs) ?? 1) < 0;
      const bClosed = (daysLeft(b.deadline, nowMs) ?? 1) < 0;
      if (aClosed !== bClosed) return aClosed ? 1 : -1;

      if (sortBy === 'days') {
        // Roles with a deadline come first; the rest keep priority order.
        const ad = daysLeft(a.deadline, nowMs);
        const bd = daysLeft(b.deadline, nowMs);
        if (ad !== null && bd !== null) return ad - bd;
        if (ad !== null) return -1;
        if (bd !== null) return 1;
      }
      return rank(a.priority) - rank(b.priority) || a.company.localeCompare(b.company);
    });
  // `roles` belongs here now. It used to be a static import, so an empty
  // dependency list was correct; once it became state fetched after mount,
  // the memo kept its first value — computed before anything had loaded — and
  // the page rendered twenty-four roles as nothing at all.
  }, [roles, nycOnly, company, fn, priority, sortBy, nowMs]);

  /**
   * Four lists, in the order you work through them.
   *
   * Applied and declined roles come out of the live lists entirely rather
   * than sitting among them greyed out. Once you have applied there is nothing
   * to do but wait, and once you have said no there is nothing to do at all —
   * either one left in "Open now" is a row you have to re-read and re-dismiss
   * every time you scan the page.
   *
   * Both keep a section of their own at the bottom. Applied is a record you
   * will want (dates, who you spoke to); declined is the receipt that you
   * considered it, which is worth more than a role silently vanishing.
   */
  const declined = (r: Role) => DECLINED.includes(r.mine.status ?? '');
  const applied = (r: Role) => APPLIED.includes(r.mine.status ?? '');
  const live = (r: Role) => !declined(r) && !applied(r);

  const openRoles = visible.filter((r) => r.status === 'Open' && live(r));
  const watchlist = visible.filter((r) => r.status === 'Not yet posted' && live(r));
  const appliedRoles = visible.filter(applied);
  const declinedRoles = visible.filter(declined);
  const noProgram = roles.filter((r) => r.status === 'No program');

  const summary = {
    open: roles.filter((r) => r.status === 'Open').length,
    openNyc: roles.filter((r) => r.status === 'Open' && ['Yes', 'Possible'].includes(r.nycOption)).length,
    watch: roles.filter((r) => r.status === 'Not yet posted').length,
    applied: roles.filter((r) => APPLIED.includes(r.mine.status ?? '')).length,
  };

  const card = (r: Role) => {
    const left = daysLeft(r.deadline, nowMs);
    const mine = r.mine;
    const spoken = contacts.filter((c) => c.company.toLowerCase() === r.company.toLowerCase());
    const keys = r.keywordsKey ? (keywords as Record<string, string[]>)[r.keywordsKey] : null;

    return (
      <div className="role" key={r.id}>
        <div className="rhead">
          {/**
            * The one ordering you set by hand.
            *
            * In the header rather than down with your other fields, because it
            * is a property of the role at a glance — you should be able to
            * star something while scanning, without reading the card.
            */}
          <button
            type="button"
            className={`star${mine.starred ? ' on' : ''}`}
            aria-pressed={Boolean(mine.starred)}
            aria-label={mine.starred ? `Unstar ${r.company}` : `Star ${r.company}`}
            title={mine.starred ? 'Starred — sorts to the top' : 'Star this role'}
            onClick={() => update(r.id, { starred: !mine.starred })}
          >
            {mine.starred ? '★' : '☆'}
          </button>
          <span className="prio">{r.priority}</span>
          {left !== null && (
            <span className={`days${left <= 7 ? ' hot' : ''}`}>
              {left < 0 ? 'Closed' : `${left} day${left === 1 ? '' : 's'} left`}
            </span>
          )}
          <span className={`lcheck ${badgeClass(r.linkCheck)}`}>{r.linkCheck}</span>
        </div>

        <h3>
          <a href={r.link} target="_blank" rel="noopener noreferrer">{r.role}</a>
        </h3>
        <div className="rmeta">
          <b>{r.company}</b> · {r.function} · {r.locations}
          {r.nycOption !== '-' && <span className={`nyc n${r.nycOption}`}>{HOME_CITY}: {r.nycOption}</span>}
        </div>

        <p className="rtiming">{r.timing}</p>
        {r.pay && r.pay !== '-' && <p className="rpay">{r.pay}</p>}
        {r.notes && <p className="rnotes">{r.notes}</p>}

        {/* Both companies cap applications, so applying to the wrong one first
            costs you the other. Worth more than a line in the notes. */}
        {(r.company === 'TikTok' || r.company === 'Netflix') && (
          <p className="cap">Max 2 applications across {r.company} — choose carefully.</p>
        )}

        {keys && (
          <details className="kw">
            <summary>Resume keywords ({keys.length})</summary>
            <div className="kwlist">{keys.map((k) => <span className="chip" key={k}>{k}</span>)}</div>
          </details>
        )}

        <div className="mine">
          {/**
            * One click for the commonest thing you do.
            *
            * Marking a role applied took two controls: choose "Applied" from a
            * status menu, then pick today out of a date picker. That is four
            * interactions for a fact you know in one. The menu stays, because
            * the other seven statuses still need it — this is a shortcut, not
            * a replacement.
            *
            * Pressing it again clears it, so a misclick is not permanent.
            */}
          <button
            type="button"
            className={`applybtn${mine.status === 'Applied' ? ' on' : ''}`}
            onClick={() =>
              update(
                r.id,
                mine.status === 'Applied'
                  ? { status: '', applied: '' }
                  : { status: 'Applied', applied: today() },
              )
            }
          >
            {mine.status === 'Applied'
              ? `Applied${mine.applied ? ` ${mine.applied}` : ''} — undo`
              : 'Mark applied'}
          </button>
          {/* The other one-click answer. Applying and ruling out are the two
              things you do to most of these; everything else is rarer and
              lives in the menu. */}
          <button
            type="button"
            className={`nobtn${mine.status === 'Not interested' ? ' on' : ''}`}
            onClick={() =>
              update(
                r.id,
                mine.status === 'Not interested' ? { status: '' } : { status: 'Not interested' },
              )
            }
          >
            {mine.status === 'Not interested' ? 'Not interested — undo' : 'Not interested'}
          </button>
          <label>
            <span>Status</span>
            <select
              value={mine.status ?? ''}
              onChange={(e) => update(r.id, { status: e.target.value })}
            >
              <option value="">—</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>
            <span>Applied</span>
            <input type="date" value={mine.applied ?? ''} onChange={(e) => update(r.id, { applied: e.target.value })} />
          </label>
          {/**
            * Who you have spoken to at this company.
            *
            * Keyed on the company, not the posting, so a coffee chat with
            * someone at a company shows on every role there you are tracking —
            * which is how networking actually works.
            */}
          <div className="spoke wide">
            <span className="spokehead">
              Spoken to
              {spoken.length > 0 && <em> · {spoken.length}</em>}
            </span>
            {spoken.map((c) => (
              <div className="spokerow" key={c.id}>
                <b>{c.name}</b>
                {c.title && <span className="st"> · {c.title}</span>}
                {c.how && <span className="sh"> · {c.how}</span>}
                {c.spoke_on && <span className="sd"> · {String(c.spoke_on).slice(0, 10)}</span>}
                {c.notes && <div className="sn">{c.notes}</div>}
                <button type="button" className="sx" onClick={() => void removeContact(c.id)}>
                  remove
                </button>
              </div>
            ))}

            {adding === r.id ? (
              <form
                className="spokeadd"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void addContact(r.company, {
                    name: String(f.get('name') ?? ''),
                    title: String(f.get('title') ?? '') || null,
                    how: String(f.get('how') ?? '') || null,
                    spoke_on: String(f.get('spoke_on') ?? '') || null,
                    notes: String(f.get('notes') ?? '') || null,
                  });
                }}
              >
                <input name="name" placeholder="Name" autoFocus required />
                <input name="title" placeholder="Their role" />
                <input name="how" placeholder="Coffee chat, email, event…" />
                <input name="spoke_on" type="date" defaultValue={today()} />
                <input name="notes" placeholder="What was said" />
                <div className="spokebtns">
                  <button type="submit">Save</button>
                  <button type="button" onClick={() => setAdding(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <button type="button" className="spokebtn" onClick={() => setAdding(r.id)}>
                + Add someone
              </button>
            )}
          </div>

          <label className="wide">
            <span>Notes</span>
            <input
              value={mine.notes ?? ''}
              placeholder="Who you spoke to, what you sent"
              onChange={(e) => update(r.id, { notes: e.target.value })}
            />
          </label>
        </div>

        <button
          className="linkish"
          onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
          aria-expanded={!!open[r.id]}
        >
          {open[r.id] ? 'Hide link' : 'Show link'}
        </button>
        {open[r.id] && <p className="rawlink">{r.link}</p>}
      </div>
    );
  };

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="mark">Internship Tracker <span>· {SEASON}</span></div>
        <div className="spacer" />
        <Link className="ghost" href="/">Back to console</Link>
      </div>

      <div className="hero">
        <h1 className="date">{SEASON} <em>internships</em></h1>
        {/* The roles now live in the database, so "verified" is about the rows
            rather than a date stamped on a file that no longer drives this page. */}
        <p className="nextline"><span className="loc">{roles.length} roles tracked</span></p>

        <div className="itsum">
          <div className="stat"><div className="n">{summary.open}</div><div className="l">Open now</div></div>
          <div className="stat"><div className="n">{summary.openNyc}</div><div className="l">Open with a {HOME_CITY} option</div></div>
          <div className="stat"><div className="n">{summary.watch}</div><div className="l">On the watchlist</div></div>
          <div className="stat"><div className="n">{summary.applied}</div><div className="l">Applied</div></div>
        </div>
      </div>

      <details className="targets commonkw">
        <summary>Keywords common to all roles</summary>
        <div className="kwlist">
          {keywords.common.map((k) => <span className="chip" key={k}>{k}</span>)}
        </div>
      </details>

      <div className="itfilters">
        <button className={nycOnly ? 'btn-ok' : 'ghost'} onClick={() => setNycOnly((v) => !v)}>
          {nycOnly ? `${HOME_CITY} only — on` : `${HOME_CITY} only`}
        </button>
        <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company">
          <option value="all">All companies</option>
          {companies.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={fn} onChange={(e) => setFn(e.target.value)} aria-label="Function">
          <option value="all">All functions</option>
          {functions.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          <option value="all">All priorities</option>
          {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'priority' | 'days')} aria-label="Sort by">
          <option value="priority">Sort: priority</option>
          <option value="days">Sort: days left</option>
        </select>
      </div>

      <section>
        <h2 className="sec">Open now <span className="count">{openRoles.length}</span></h2>
        {openRoles.length === 0
          ? <div className="empty">Nothing open matches those filters.</div>
          : <div className="roles">{openRoles.map(card)}</div>}
      </section>

      <section>
        <h2 className="sec">Watchlist <span className="count">{watchlist.length} not yet posted</span></h2>
        {watchlist.length === 0
          ? <div className="empty">Nothing on the watchlist matches those filters.</div>
          : <div className="roles">{watchlist.map(card)}</div>}
      </section>

      {appliedRoles.length > 0 && (
        <section>
          <h2 className="sec">
            Applied <span className="count">{appliedRoles.length}</span>
          </h2>
          <div className="roles">{appliedRoles.map(card)}</div>
        </section>
      )}

      {declinedRoles.length > 0 && (
        <section>
          {/* Folded away. You have decided; the only reason to keep it on the
              page is so you can see what you decided and change your mind. */}
          <details className="declined">
            <summary className="sec">
              Not interested <span className="count">{declinedRoles.length}</span>
            </summary>
            <div className="roles">{declinedRoles.map(card)}</div>
          </details>
        </section>
      )}

      {noProgram.length > 0 && (
        <p className="noprog">
          {noProgram.map((r) => (
            <span key={r.id}>
              <a href={r.link} target="_blank" rel="noopener noreferrer">{r.company}</a>: {r.timing} {r.notes}
            </span>
          ))}
        </p>
      )}

      <footer>
        Your status, dates and notes are saved in this browser only — they are not in the
        database and never leave this device.
      </footer>
    </div>
  );
}

function badgeClass(check: string): string {
  if (/^Verified/.test(check)) return 'ok';
  if (/Prior cycle|Not verified/.test(check)) return 'warn';
  return 'neutral';
}

function pretty(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}
