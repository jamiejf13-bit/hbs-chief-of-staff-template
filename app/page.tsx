'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rankForToday, suggestion } from '@/lib/score';
import { nextGap } from '@/lib/gaps';
import Calendar from './Calendar';
import EventDialog, { type DraftEvent } from './EventDialog';
import AgentChat from './AgentChat';
import targets from '@/lib/targets.json';
import { useBrand, useCourseRe } from './BrandProvider';
import { networkTargets } from '@/lib/networking';
import {
  CATEGORIES, COURSES,
  type Category, type ConsoleState, type CalEvent, type Course,
  type Participation, type ColdCallRisk, type Task, type TaskLink, type EmailItem,
  type Person, type JobPosting,
} from '@/lib/types';

type Filter = 'all' | Category;
type Range = 'today' | 'week';
type Horizon = 'next' | 'week' | 'all';

const COURSE_VAR: Record<Course, string> = {
  MKT: 'var(--mkt)', STRAT: 'var(--strat)', FRC: 'var(--frc)',
  TOM: 'var(--tom)', LEAD: 'var(--lead)', FIN1: 'var(--fin)',
};
const CAT_VAR: Record<Category, string> = {
  class: 'var(--adm)', recruiting: 'var(--rec)', social: 'var(--lead)',
  clubs: 'var(--tom)', admin: 'var(--adm)', personal: 'var(--adm)',
};

export default function ConsolePage() {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** undefined = untouched this session, so fall back to the stored pref. */
  /** Which assignments have their detail open. Per-session; not worth storing. */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  /**
   * A week, not "through the next class day".
   *
   * The tighter default was a mistake: it hid ninety of a hundred-odd
   * assignments behind a control nobody had been told about, and the page
   * read as though Canvas had stopped working. A default that cannot be
   * told apart from data loss is the wrong default, however tidy it looks.
   */
  const [horizon, setHorizon] = useState<Horizon>('week');
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  /** Brief confirmation after an add, so the button visibly did something. */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  /** What has happened to each recruiting row, so a click visibly lands. */
  const [rsvp, setRsvp] = useState<Record<string, string>>({});

  const [range, setRange] = useState<Range>('today');
  const [filter, setFilter] = useState<Filter>('all');
  const [localDone, setLocalDone] = useState<Record<string, boolean>>({});
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  /** Notes typed against pending actions, keyed by action id. */
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** The event dialog. `draft` open means visible; `editing` means it exists. */
  const [draft, setDraft] = useState<DraftEvent | null>(null);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [dlgBusy, setDlgBusy] = useState(false);
  const [dlgErr, setDlgErr] = useState<string | null>(null);
  /** Measured height of the right rail; the calendar is sized to match. */
  const railRef = useRef<HTMLElement | null>(null);
  const [railHeight, setRailHeight] = useState<number | null>(null);
  const [dark, setDark] = useState<boolean | null>(null);

  /**
   * These two live up here with the rest, and must.
   *
   * They were declared further down, beside the functions that use them —
   * which reads well and is a rules-of-hooks violation: the component
   * returns early while state is still loading, so on the first render
   * these were never called and on the second they were. React counts
   * hooks, saw two extra, and threw. The page went white in production
   * with "a client-side exception has occurred", which no build or
   * typecheck catches because it only happens once data arrives.
   */
  /** Which mail items have been turned into a to-do this session. */
  const [mailTasked, setMailTasked] = useState<Record<string, boolean>>({});
  /** Whether a mailbox re-read has been asked of the laptop. */
  const [mailRefresh, setMailRefresh] = useState<'idle' | 'asked'>('idle');

  /**
   * Which sign-in window has been asked for, if any.
   *
   * UP HERE WITH THE OTHER HOOKS, and that is not a style preference. This
   * component returns early while state is loading and again on an error, and
   * a hook declared after those returns is called on some renders and not
   * others — which React answers by throwing, and the page becomes
   * "Application error: a client-side exception has occurred". It was
   * originally written next to the function that uses it, four hundred lines
   * below both returns, and took the live site down.
   *
   * This is the second time this exact mistake has been made in this file.
   */
  const [loginOpening, setLoginOpening] = useState<string | null>(null);

  /** Roles already sent to the internships tracker, so the button can say so.
   *  Up here with the other hooks — there are early returns below. */
  const [tracked, setTracked] = useState<Record<string, boolean>>({});

  /** Branding and course codes, from the server layout. Hooks, so up here too. */
  const brand = useBrand();
  const courseRe = useCourseRe();
  const courseOf = useCallback((title: string) => courseIn(title, courseRe), [courseRe]);

  /**
   * Record a decision. The API only stores it — the worker on the laptop does
   * the actual work, because it is the only machine that can reach Outlook.
   * The card disappears on success; on failure it stays with the reason, so a
   * tap never silently does nothing.
   */
  async function decide(id: string, decision: 'approve' | 'skip' | 'remove', progress: string) {
    setBusy((b) => ({ ...b, [id]: progress }));
    try {
      const res = await fetch(`/api/actions/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, note: notes[id]?.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setBusy((b) => ({ ...b, [id]: body.error ?? `Failed (${res.status})` }));
        return;
      }
      setResolved((r) => ({ ...r, [id]: decision }));
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    } catch {
      setBusy((b) => ({ ...b, [id]: 'Network error — try again.' }));
    }
  }

  /* ---- theme ---- */
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem('cos-theme'); } catch { /* private mode */ }
    if (stored === 'dark' || stored === 'light') {
      document.documentElement.setAttribute('data-theme', stored);
      setDark(stored === 'dark');
    } else {
      setDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
  }, []);

  function toggleTheme() {
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('cos-theme', next); } catch { /* ignore */ }
    setDark(next === 'dark');
  }

  /* ---- state ---- */
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `State unavailable (${res.status})`);
      }
      setState(await res.json() as ConsoleState);
      // A successful reload clears any earlier failure; leaving it up would
      // claim the page is broken while showing current data.
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Match the calendar's height to the right rail, ending level with Sources.
   *
   * Measured rather than guessed: the rail's height depends on how many
   * recruiting items and courses there are, so a fixed number would be right
   * on one day and wrong the next. Only applied on wide layouts — once the
   * rail stacks underneath, there is no shared edge to line up with.
   */
  useEffect(() => {
    const el = railRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const wide = window.matchMedia('(min-width: 921px)').matches;
      setRailHeight(wide ? Math.max(320, el.getBoundingClientRect().height) : null);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [state]);

  /**
   * Save one field on one task, then reload.
   *
   * Optimism is deliberately avoided here: re-categorising changes which
   * filter tab a task belongs to and where the ranking puts it, so guessing
   * the result on the client would make rows jump and then jump back. The
   * round trip is fast enough.
   */
  const patch = useCallback(async (id: string, body: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) { setAddErr(b.error ?? `Could not save (${res.status}).`); return; }
      setAddErr(b.warning ?? null);
      await load();
    } catch {
      setAddErr('Could not reach the server. Nothing was saved.');
    }
  }, [load]);

  const nowMs = state ? Date.parse(state.now) : Date.now();

  const tasks = useMemo(
    () => (state?.tasks ?? []).map((t) => (t.id in localDone ? { ...t, done: localDone[t.id] } : t)),
    [state, localDone],
  );

  /**
   * Tick a to-do off, and keep it ticked off.
   *
   * `localDone` alone was the whole implementation: the checkbox set a React
   * state object, the list read back through it, and nothing was ever sent
   * anywhere. It looked right until the page was reloaded, at which point
   * every completed task came back — so on the phone, which is a
   * fresh load every time, ticking things off did nothing at all. The most
   * common action on the page was the one that did not persist.
   *
   * The local flag stays, because it is what makes the tap feel immediate,
   * but it is now an optimistic guess that is confirmed or withdrawn. On
   * failure it is withdrawn and the reason is shown, rather than leaving
   * a tick on screen that is not real.
   */
  const setDone = useCallback(async (id: string, done: boolean) => {
    setLocalDone((d) => ({ ...d, [id]: done }));
    setAddErr(null);
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ done }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setLocalDone((d) => {
          const next = { ...d };
          delete next[id];
          return next;
        });
        setAddErr(b.error ?? `Could not save that (${res.status}).`);
      }
    } catch {
      setLocalDone((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
      setAddErr('Could not reach the server — that tick was not saved.');
    }
  }, []);

  const ranked = useMemo(
    () => (state ? rankForToday(tasks, state.weights, nowMs) : []),
    [state, tasks, nowMs],
  );

  const todaysEvents = useMemo(
    () => (state?.events ?? []).filter((e) => sameDay(e.start_at, nowMs)).sort(byStart),
    [state, nowMs],
  );

  /**
   * Companies worth networking into, and the searches that find people there.
   * Derived, not stored — it is a view over events and jobs already stored,
   * so it needs no table and cannot go stale against them.
   */
  const network = useMemo(
    () => networkTargets(state?.events ?? [], state?.jobs ?? []),
    [state],
  );

  const line = useMemo(() => {
    if (!state) return null;
    const gap = nextGap(todaysEvents, nowMs);
    return suggestion(ranked, gap?.minutes ?? null, gap?.label ?? null);
  }, [state, ranked, todaysEvents, nowMs]);

  if (error) {
    return (
      <div className="wrap">
        <div className="topbar"><div className="mark">{brand.appName}</div></div>
        <div className="banner bad" role="alert">
          <strong>Could not load your day.</strong> {error} — this is a real failure, not an empty schedule.
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="wrap">
        <div className="topbar"><div className="mark">{brand.appName} <span>· {brand.term}</span></div></div>
        <div className="hero"><h1 className="date">Loading<em>…</em></h1></div>
      </div>
    );
  }

  const byCategory = filter === 'all' ? ranked : ranked.filter((t) => t.category === filter);
  const pending = state.actions.filter((a) => a.status === 'pending' && !(a.id in resolved));
  const onCalendar = calendarEvents(state.events);
  /** Changes that reached Google and still need doing in Outlook by hand. */
  const outlookGaps = state.events
    .filter((e) => e.outlook_needs && Date.parse(e.start_at) > nowMs - 3600_000)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const next = nextEvent(onCalendar, nowMs);
  const nextCourse = next ? courseOf(next.title) : null;
  const part = nextCourse ? state.participation.find((p) => p.course === nextCourse) ?? null : null;
  const risk = part ? riskOf(part) : null;


  // A source that stopped is worth more of the screen than a source that is
  // fine. The Google one gets its own wording because it is expected, roughly
  // weekly, and has a one-command fix — it is a chore, not a fault.
  const broken = state.sources.filter((s) => s.status === 'error');
  const googleExpired = broken.some(
    (s) => s.name === 'gcal' && /invalid_grant|refresh token/i.test(s.last_error ?? ''),
  );
  const otherBroken = broken.filter((s) => !(s.name === 'gcal' && googleExpired));

  /**
   * Sources that still work but are about to stop.
   *
   * Only shown for ones that are actually green: once something has broken the
   * error banner says so, and two banners about the same source would be noise.
   */
  const warnings = (state?.sources ?? []).filter((s) => s.status === 'ok' && s.warning);

  /**
   * 12Twenty is out, taking the networking and alumni readers with it.
   *
   * Keyed off 12twenty itself rather than off all three, because people and
   * alumni fail for the same single reason and three banners about one
   * sign-in would be three times the noise and none of the extra information.
   */
  const twelveTwentyDown = broken.some((s) => s.name === '12twenty');

  /**
   * The next day that actually has class. Drives both the list's default
   * horizon and the "next class day" header, so getting ahead on a weekend
   * means scrolling rather than opening a second panel.
   */
  const tomorrowKey = dayKey(nowMs + 86_400_000);
  const classDays = [...new Set(
    state.events
      .filter((e) => courseOf(e.title) && Date.parse(e.start_at) > nowMs)
      .map((e) => dayKey(Date.parse(e.start_at))),
  )].sort();
  const nextClassDay = classDays[0] ?? null;
  const classTomorrow = nextClassDay === tomorrowKey;

  /**
   * How far down the list to show.
   *
   * 99 Canvas assignments run to November. Showing all of them by default
   * buries tonight's reading, which is the failure mode that gets a system
   * like this abandoned — so the default stops at the next day that actually has
   * class, and getting ahead is one control away rather than a separate panel.
   */
  const horizonEnd =
    horizon === 'all' ? null
    : horizon === 'week' ? dayKey(nowMs + 7 * 86_400_000)
    : (nextClassDay ?? dayKey(nowMs + 86_400_000));

  const visible = horizonEnd === null
    ? byCategory
    : byCategory.filter((t) => {
        // No deadline and hand-pinned rows always show: neither has a day to
        // be beyond the horizon, and hiding a task you positioned yourself
        // would look like it had been lost.
        if (!t.due_at) return true;
        if (t.sort_order != null) return true;
        return dayKey(Date.parse(t.due_at)) <= horizonEnd;
      });

  const hiddenByHorizon = byCategory.length - visible.length;

  const mail = (kind: EmailItem['kind']) => state.emails.filter((m) => m.kind === kind);

  /**
   * Clear one recruiting row.
   *
   * Two outcomes, because they mean different things: you registered, or it
   * was never relevant. Both tick the task off, but the note records which,
   * so the ranking can learn later and you can tell them apart now.
   */
  async function clearRecruiting(row: RailRow, why: 'registered' | 'not-relevant' | 'register-me') {
    // A sign-up to-do raised for a 12Twenty event knows which event it is;
    // "sign me up" on one has to reach the event, not just tick the task.
    if (row.taskId && why !== 'register-me') {
      setLocalDone((d) => ({ ...d, [row.taskId!]: true }));
      await patch(row.taskId, { done: true });
      return;
    }
    if (row.eventId) {
      // No task behind it — it is a 12Twenty session. Marking it registered
      // records the fact; marking it irrelevant hides it.
      // "Sign me up" is not done until the laptop says so, so the row stays
      // put and says it is queued rather than vanishing on a promise.
      if (why !== 'register-me') {
        setState((s) => (s ? {
          ...s,
          events: s.events.map((e) =>
            e.id === row.eventId ? { ...e, registered: true, recruiting_dismissed: true } : e),
        } : s));
      } else {
        // Immediate, and next to the button. Silence is what gets a button
        // pressed five times.
        setRsvp((r) => ({ ...r, [row.eventId!]: 'Signing you up…' }));
      }
      try {
        const res = await fetch(`/api/events/${row.eventId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recruiting_cleared: why }),
        });
        const b = await res.json().catch(() => ({}));
        if (why === 'register-me') {
          setRsvp((r) => ({
            ...r,
            [row.eventId!]: res.ok
              ? (b.already ? 'Already queued — the laptop will do it' : 'Queued — the laptop is registering you')
              : (b.error ?? 'That did not work'),
          }));
        }
      } catch {
        if (why === 'register-me') {
          setRsvp((r) => ({ ...r, [row.eventId!]: 'Could not reach the server' }));
        }
      }
    }
  }

  // One list, two sources. Where a posting came from is not a question anyone is
  // asking, so the panel counts them together.
  const openRoles = state.jobs.length + mail('linkedin_role').length;

  /** Hide a job board posting. Same shape as dismissing a mail item. */
  /**
   * Record what was decided about a role.
   *
   * Both answers remove the row, because both mean "done with this" — but
   * they are opposite facts and the database keeps them apart. Applied is the
   * only record of applying at all, which is worth more than tidiness.
   *
   * Removed from the list first, then written. If the write fails the row is
   * back on the next load, which is the honest outcome: nothing was recorded,
   * so nothing should look as though it was.
   */
  /**
   * Send a found role to the internships tracker.
   *
   * These two lists were entirely separate: the tracker was a file compiled
   * into the site with personal notes in browser storage, so a role the boards
   * found could never reach the page actually worked from. Now both are
   * rows in the same database and this is the join between them.
   *
   * The row stays in New roles afterwards — tracking something is not the
   * same as being done with it, and applying still has to happen.
   */
  async function trackJob(j: JobPosting) {
    if (tracked[j.id]) return;
    setTracked((t) => ({ ...t, [j.id]: true }));
    try {
      const res = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: j.id,
          company: j.company,
          role: j.title,
          locations: j.location,
          link: j.url,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setTracked((t) => ({ ...t, [j.id]: false }));
      setAddErr('Could not reach the server — that was not added to the tracker.');
    }
  }

  async function markJob(id: string, action: 'applied' | 'dismissed') {
    setState((s) => (s ? { ...s, jobs: s.jobs.filter((j) => j.id !== id) } : s));
    try {
      const res = await fetch(`/api/jobs/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      await load();
      setAddErr('Could not reach the server — that was not recorded.');
    }
  }

  /**
   * Mark one mail item dealt with. Local first — the row vanishes on the tap —
   * because this is a dismissal, and a dismissal that waits for the network
   * feels broken even when it works.
   */
  /**
   * Clear a mail item, saying which kind of clearing it is.
   *
   * "Done with it" and "not relevant" look the same on screen and mean very
   * different things: only the second says anything about what you want to
   * see in future, and only the second is worth learning from. Collapsing
   * them would teach the wrong lesson from every email you simply finished.
   */
  /**
   * Turn an email into a to-do.
   *
   * The common case for anything in this panel: it needs doing, but not in
   * the next ten minutes. Without this the only ways out of the list are
   * "done" and "not relevant", neither of which is true, so things you mean
   * to action sit there being re-read every morning.
   *
   * The message link travels with the task, because "Reply to Pat about
   * the trek" is useless if finding the thread again means searching the
   * mailbox. The row is left in place rather than cleared: the email is still
   * unanswered, and saying otherwise would be a small lie that compounds.
   */

  /**
   * Ask the laptop to re-read the mailbox now.
   *
   * The website cannot read Outlook itself — that needs the signed-in browser
   * on the laptop — so this queues the request and the worker picks it up
   * within a minute. The button says which of those two things is happening,
   * because "nothing visibly changed" is the failure mode of every button
   * that triggers work somewhere else.
   */

  async function refreshMail() {
    setMailRefresh('asked');
    try {
      await fetch('/api/email/refresh', { method: 'POST' });
      // The worker polls for approved actions every minute; give it that long
      // before reloading, or the reload shows exactly what was there before.
      window.setTimeout(() => { void load(); setMailRefresh('idle'); }, 70_000);
    } catch {
      setMailRefresh('idle');
      setAddErr('Could not reach the server — the mailbox was not refreshed.');
    }
  }

  async function addMailTask(m: EmailItem) {
    setMailTasked((t) => ({ ...t, [m.id]: true }));
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: m.subject.slice(0, 200),
          // Recruiting is the stated first priority, and this panel is mostly
          // recruiting and class work; admin is the honest default otherwise.
          category: /\b(intern|recruit|career|coffee chat|trek|application|apply)\b/i.test(m.subject)
            ? 'recruiting'
            : 'admin',
          url: m.url ?? undefined,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setMailTasked((t) => ({ ...t, [m.id]: false }));
        setAddErr(b.error ?? 'Could not add that to your list.');
        return;
      }
      await load();
    } catch {
      setMailTasked((t) => ({ ...t, [m.id]: false }));
      setAddErr('Could not reach the server — that was not added.');
    }
  }

  /**
   * Ask the laptop worker to open a sign-in window.
   *
   * Queued as an action rather than done here, because a web page cannot open
   * a browser on your desk — only the worker on that machine can. Which also
   * means this does nothing while the laptop is off, and the button says so
   * rather than spinning: the worker is the thing that can answer it.
   */
  async function openSignIn(type: 'twelvetwenty_login' | 'google_auth') {
    setLoginOpening(type);
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          summary: 'Open a sign-in window on the laptop',
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The worker picks it up on its next pass, which is within a minute.
      setTimeout(() => setLoginOpening(null), 60_000);
    } catch {
      setLoginOpening(null);
      setAddErr('Could not reach the server — the sign-in window was not opened.');
    }
  }

  async function handleMail(id: string, reason: 'handled' | 'not_relevant' = 'handled') {
    setState((s) => (s ? { ...s, emails: s.emails.filter((m) => m.id !== id) } : s));
    try {
      await fetch(`/api/email/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
    } catch {
      // It reappears on the next load. Nothing was lost.
    }
  }

  /**
   * Record what was decided about a person, and let it teach the scorer.
   *
   * Removed from the list immediately in all three cases, including "reached
   * out" — the panel is a queue of people to deal with, and someone you have
   * just messaged is dealt with. The row itself is kept, so a re-sync of the
   * directory cannot put them back in front of you.
   */
  async function decidePerson(p: Person, status: 'to_contact' | 'contacted' | 'not_interested') {
    setState((s) => (s ? { ...s, people: s.people.filter((x) => x.id !== p.id) } : s));
    try {
      await fetch(`/api/people/${p.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch {
      // They reappear on the next load, which is the honest outcome: nothing
      // was recorded, so nothing should look as though it was.
      await load();
    }
  }


  return (
    <div className="wrap">
      <div className="topbar">
        <div className="mark">{brand.appName} <span>· {brand.term}</span></div>
        {state.seeded && <div className="sample">Sample data</div>}
        {!state.seeded && state.worker_offline && <div className="sample bad">Worker offline</div>}
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Range">
          <button aria-pressed={range === 'today'} onClick={() => setRange('today')}>Today</button>
          <button aria-pressed={range === 'week'} onClick={() => setRange('week')}>Week</button>
        </div>
        <button className="ghost" onClick={toggleTheme}>{dark ? 'Light' : 'Dark'}</button>
      </div>

      <div className="hero">
        <h1 className="date">
          {new Date(nowMs).toLocaleDateString([], { weekday: 'long' })}{' '}
          <em>{new Date(nowMs).toLocaleDateString([], { day: 'numeric', month: 'short' })}</em>
        </h1>

        {next ? (
          <p className="nextline">
            <span className={`tick${risk === 'high' ? ' hot' : ''}`}>{untilLabel(next.start_at, nowMs)}</span>
            <span>
              {next.title}
              {risk && part && ` — Cold call risk: ${risk}, ${spokeLabel(part)}`}
            </span>
            <span className="loc">
              {next.location ? `${next.location} · ` : ''}{hhmm(next.start_at)}
            </span>
          </p>
        ) : (
          <p className="nextline"><span>Nothing else scheduled today.</span></p>
        )}

      </div>

      {state.seeded && (
        <div className="banner">
          <strong>Sample data.</strong> No database is configured, so nothing here comes from your real
          accounts and nothing you tick will save.
        </div>
      )}

      {/* The worker is the only thing that can reach Canvas, Outlook and
          12Twenty. When it is not running, the page is a photograph. */}
      {!state.seeded && state.worker_offline && (
        <div className="banner bad" role="alert">
          <strong>The laptop worker has stopped.</strong>{' '}
          {state.cloud_offline
            ? 'Nothing is syncing at all, and nothing you approve will be carried out'
            : 'Canvas, Gmail and Google Calendar are still syncing from the cloud, but '
              + 'Outlook, 12Twenty and your Class Log are not — and nothing you approve '
              + 'will be carried out until the laptop is back'}
          {' — '}what is below is the last good read
          {state.worker_last_beat ? ` from it, ${relative(state.worker_last_beat, nowMs)}` : ''}.
          To start it now, run{' '}
          <code>npm run worker</code> from the project folder on the laptop.
        </div>
      )}

      {/* There is no cloud-only banner any more.

          It fired whenever the cloud was quiet, which GitHub makes close to
          permanent: measured over twenty-eight hours, seven scheduled runs
          happened where sixty were asked for, every one of them green. GitHub
          drops scheduled runs on free runners and documents that it does. In
          the same period the laptop covered for it 191 times without comment,
          which is the two halves working exactly as intended — so the banner
          was an alarm about a healthy system, and that is how alarms stop
          being read.

          The state that does matter, both halves quiet, is already said by the
          laptop banner above: it reads cloud_offline to choose between "the
          cloud is still covering" and "nothing is syncing at all". One banner,
          in the one case where you can do something about it. */}

      {!state.seeded && !state.worker_offline && state.worker_code_stale && (
        <div className="banner" role="status">
          <strong>The worker needs restarting.</strong> It is running code from before the
          last change, so newer features will not work — that is why registering silently
          did nothing earlier. Stop and start it, or restart the laptop.
        </div>
      )}

      {!state.seeded && googleExpired && (
        <div className="banner bad" role="alert">
          <strong>Google needs reconnecting.</strong> The seven-day token has expired, so anything you
          add or move in Google Calendar is not reaching this page. Outlook, Canvas and your tasks are
          unaffected. On the laptop, run{' '}
          <button
            className="linkish"
            disabled={loginOpening === 'google_auth'}
            onClick={() => void openSignIn('google_auth')}
          >
            {loginOpening === 'google_auth' ? 'Opening the consent window…' : 'Reconnect Google'}
          </button>{' '}
          and approve once.
          {/* The seven days are a consequence of the OAuth app being in Testing,
              not of anything here, so the lasting fix is a setting in Google
              Cloud rather than another reconnect. Said on the banner because
              this is where you read about it, every seventh day. */}
          <br />
          <span className="bannernote">
            This recurs every seven days because the Google app is in Testing. Publishing it to
            Production in the Google Cloud console stops the expiry for good — after that, this
            reconnect is a one-off.
          </span>
        </div>
      )}

      {/* 12Twenty's sign-in, as a button rather than a terminal command.

          Harvard expires the SSO ticket after about a day and a half and no
          code changes a university's session policy. What it changes is the
          cost of it: a path typed into a terminal every other day, and
          impossible from the phone the notification usually arrives on.

          The action runs on the laptop, so this does nothing unless you are at
          the machine that can answer it. That is correct, not a limitation —
          the Harvard password is yours to type and nothing here will enter it. */}
      {!state.seeded && twelveTwentyDown && (
        <div className="banner bad" role="alert">
          <strong>12Twenty needs a sign-in.</strong> Harvard expires the ticket after about a
          day and a half, whatever the cookie says. Recruiting events, networking contacts and
          registrations are paused until it is done; everything else is unaffected.{' '}
          <button
            className="linkish"
            disabled={loginOpening === 'twelvetwenty_login'}
            onClick={() => void openSignIn('twelvetwenty_login')}
          >
            {loginOpening === 'twelvetwenty_login' ? 'Opening the sign-in window…' : 'Open the sign-in window'}
          </button>
        </div>
      )}

      {/* Something still working that will stop soon.

          Above the content and below the broken-source banner, in a softer
          colour: it is not an error and should not look like one, but the
          whole value of it is being seen in time. It can only appear while the
          laptop worker is running — which is exactly when you can act on it. */}
      {!state.seeded && warnings.length > 0 && (
        <div className="banner warn" role="status">
          {warnings.map((s) => s.warning).join(' · ')}
        </div>
      )}

      {!state.seeded && otherBroken.length > 0 && (
        <div className="banner bad" role="alert">
          <strong>
            {otherBroken.map((s) => sourceName(s.name)).join(' and ')} stopped syncing.
          </strong>{' '}
          {otherBroken[0].last_error ?? 'No reason was recorded.'} What is below is the last good read,
          not an empty schedule.
        </div>
      )}

      <div className="grid">
        <main>
          {/* The calendar comes first and the to-do list follows it.

              There used to be a "Today" timeline above both. It restated the
              calendar immediately below it — the same events, an hour
              earlier in the scroll — so it went: the short calendar, then
              straight to the to-do list. The prep
              links it carried are on the tasks themselves. */}

          <div id="calendar" />
          <Calendar
            events={onCalendar}
            tasks={state.tasks}
            nowMs={nowMs}
            courseOf={courseOf}
            courseVar={COURSE_VAR}
            readOnly={state.seeded}
            maxHeight={railHeight}
            onCreate={(startISO, endISO) => {
              setDlgErr(null);
              setDraft({ title: '', start_at: startISO, end_at: endISO, location: '', task_id: null });
            }}
            onMove={async (id, startISO, endISO) => {
              try {
                const res = await fetch(`/api/events/${id}`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ start_at: startISO, end_at: endISO }),
                });
                const b = await res.json().catch(() => ({}));
                if (!res.ok) { setAddErr(b.error ?? `Could not move it (${res.status}).`); return; }
                setAddErr(null);
                await load();
              } catch {
                setAddErr('Could not reach the server. Nothing was moved.');
              }
            }}
            onOpen={(ev) => {
              setDlgErr(null);
              setEditing(ev);
              setDraft({
                id: ev.id,
                title: ev.title,
                start_at: ev.start_at,
                end_at: ev.end_at ?? new Date(Date.parse(ev.start_at) + 3600_000).toISOString(),
                location: ev.location ?? '',
                task_id: ev.task_id,
              });
            }}
          />

          {draft && (
            <EventDialog
              draft={draft}
              existing={editing}
              tasks={tasks}
              busy={dlgBusy}
              error={dlgErr}
              onClose={() => { setDraft(null); setEditing(null); setDlgErr(null); }}
              onSave={async (d) => {
                setDlgBusy(true);
                try {
                  const res = d.id
                    ? await fetch(`/api/events/${d.id}`, {
                        method: 'PATCH',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          title: d.title, start_at: d.start_at, end_at: d.end_at,
                          location: d.location || null, task_id: d.task_id,
                        }),
                      })
                    : await fetch('/api/events', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          title: d.title, start_at: d.start_at, end_at: d.end_at,
                          location: d.location || null, task_id: d.task_id,
                        }),
                      });
                  const b = await res.json().catch(() => ({}));
                  if (!res.ok) { setDlgErr(b.error ?? `Could not save (${res.status}).`); return; }
                  setDraft(null); setEditing(null);
                  setAddErr(b.warning ?? null);
                  await load();
                } catch {
                  setDlgErr('Could not reach the server. Nothing was saved.');
                } finally {
                  setDlgBusy(false);
                }
              }}
              onDelete={editing ? async () => {
                setDlgBusy(true);
                try {
                  const res = await fetch(`/api/events/${editing.id}`, { method: 'DELETE' });
                  const b = await res.json().catch(() => ({}));
                  if (!res.ok) { setDlgErr(b.error ?? `Could not delete (${res.status}).`); return; }
                  setDraft(null); setEditing(null);
                  setAddErr(b.warning ?? null);
                  await load();
                } catch {
                  setDlgErr('Could not reach the server. Nothing was deleted.');
                } finally {
                  setDlgBusy(false);
                }
              } : null}
            />
          )}
          {addErr && <div className="adderr" role="alert">{addErr}</div>}

          {range === 'today' ? (
            <>


              <section id="todo">
                <h2 className="sec">
                  To Do List <span className="count">{visible.length} open</span>
                  {/* The horizon replaces the old "Get ahead" panel. With the
                      list grouped by day, getting ahead is just looking
                      further down it — and over a break you shorten the
                      horizon rather than dismissing a card. */}
                  <span className="spacer" />
                  <select
                    className="recat"
                    aria-label="How far ahead to show"
                    value={horizon}
                    onChange={(e) => setHorizon(e.target.value as Horizon)}
                  >
                    <option value="next">
                      {classTomorrow ? 'Through tomorrow' : 'Through next class day'}
                    </option>
                    <option value="week">Next 7 days</option>
                    <option value="all">Everything</option>
                  </select>
                </h2>
                <div className="tabs" role="group" aria-label="Filter">
                  <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
                  {CATEGORIES.map((c) => (
                    <button key={c} aria-pressed={filter === c} onClick={() => setFilter(c)}>{cap(c)}</button>
                  ))}
                </div>
                <form
                  className="addrow"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const title = String(fd.get('title') ?? '').trim();
                    // Say so. Returning quietly is indistinguishable from the
                    // button being broken, which is what it looked like.
                    if (!title) { setAddErr('Give the task a name first.'); return; }
                    const form = e.currentTarget;
                    const due = String(fd.get('due_at') ?? '');
                    const cat = String(fd.get('category') ?? 'personal') as Category;
                    setAdding(true);
                    try {
                      const res = await fetch('/api/tasks', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                          title,
                          category: fd.get('category') || 'personal',
                          course: fd.get('course') || null,
                          due_at: fd.get('due_at') || null,
                          priority: fd.get('priority') || null,
                        }),
                      });
                      const b = await res.json().catch(() => ({}));
                      if (!res.ok) { setAddErr(b.error ?? `Could not save (${res.status}).`); return; }
                      setAddErr(null);
                      form.reset();

                      /**
                       * Make sure the thing you just added is on screen.
                       *
                       * A new task can land outside the active category tab or
                       * past the horizon, and then adding it looks exactly
                       * like the button not working — which is how this was
                       * reported. So the view moves to the task rather than
                       * the task having to fall inside the view.
                       */
                      if (filter !== 'all' && filter !== cat) setFilter('all');
                      if (due && dayKey(Date.parse(due)) > (horizonEnd ?? '9999')) setHorizon('all');
                      setJustAdded(title);
                      window.setTimeout(() => setJustAdded(null), 4000);

                      await load();
                    } catch {
                      setAddErr('Could not reach the server. Nothing was saved.');
                    } finally {
                      setAdding(false);
                    }
                  }}
                >
                  <input name="title" placeholder="Add a task…" aria-label="Task" maxLength={500} />
                  <select name="category" aria-label="Category" defaultValue="personal">
                    {CATEGORIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
                  </select>
                  <select name="course" aria-label="Class" defaultValue="">
                    <option value="">No class</option>
                    {COURSES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input name="due_at" type="datetime-local" aria-label="Deadline" />
                  <select name="priority" aria-label="Priority" defaultValue="">
                    <option value="">Priority: auto</option>
                    <option value="1">High</option>
                    <option value="2">Normal</option>
                    <option value="3">Low</option>
                  </select>
                  <button className="btn-ok" disabled={adding || state.seeded}>
                    {adding ? 'Saving…' : 'Add'}
                  </button>
                </form>
                {addErr && <div className="adderr" role="alert">{addErr}</div>}
                {justAdded && <div className="addok" role="status">Added “{justAdded}”.</div>}
                {hiddenByHorizon > 0 && (
                  <div className="horizonnote">
                    {hiddenByHorizon} more further out.{' '}
                    <button className="linkish" onClick={() => setHorizon('all')}>
                      Show everything
                    </button>
                  </div>
                )}

                {visible.length === 0 ? (
                  <div className="empty">Nothing in this category.</div>
                ) : (
                  <ul className="q">
                    {visible.map((t, i) => (
                      <Fragment key={t.id}>
                      {/* One list, grouped by the day the work is for. This is
                          where "Today" and "Get ahead" live now — they were
                          separate panels saying things the list already knew,
                          which meant reading three lists to plan one evening. */}
                      {groupLabel(visible, i, nowMs, nextClassDay) && (
                        <li className="qgroup" aria-hidden={false}>
                          <span>{groupLabel(visible, i, nowMs, nextClassDay)}</span>
                        </li>
                      )}
                      <li>
                        <input
                          type="checkbox"
                          id={`t-${t.id}`}
                          checked={t.done}
                          aria-label={t.title}
                          onChange={(e) => void setDone(t.id, e.target.checked)}
                        />
                        <div className="txt">
                          <b>
                            {t.title}
                            {(t.prompt || t.notes || t.writeup || t.links.length > 1) && (
                              <button
                                className="disc"
                                aria-expanded={!!open[t.id]}
                                aria-label={open[t.id] ? 'Hide the question' : 'Show the question'}
                                onClick={() => setOpen((o) => ({ ...o, [t.id]: !o[t.id] }))}
                              >
                                {open[t.id] ? '▾' : '▸'}
                              </button>
                            )}
                            {/* Say that an answer is already written without
                                making you open every row to find out. */}
                            {t.response && (
                              <span className="hasresp" title="You have a prepared response">
                                answered
                              </span>
                            )}
                          </b>
                          <div className="meta">
                            {t.due_at && (
                              <span className={dueHot(t.due_at, nowMs) ? 'due-hot' : undefined}>
                                {dueLabel(t.due_at, nowMs)}
                              </span>
                            )}
                            {t.due_at && ' · '}
                            {t.origin === 'mirrored' ? t.source : 'added by you'}
                            {/* A guess is marked as one. The calendar maths
                                that will read est_minutes should not launder a
                                model's estimate into something you decided —
                                and when a number looks wrong you need to see
                                at a glance whether it was yours. */}
                            {t.est_minutes ? (
                              <span
                                className={t.est_source === 'model' ? 'est guess' : 'est'}
                                title={
                                  t.est_source === 'model'
                                    ? `Estimated${t.est_why ? `: ${t.est_why}` : ''} — not set by you`
                                    : undefined
                                }
                              >
                                {' · '}
                                {t.est_source === 'model' ? '~' : ''}
                                {t.est_minutes} min
                              </span>
                            ) : ''}
                            {/* The work window, kept visible rather than used
                                to hide the task. Getting ahead is allowed;
                                not knowing what is ahead is not. */}
                            {t.work_opens_at && Date.parse(t.work_opens_at) > nowMs && (
                              <span className="early"> · ahead of schedule</span>
                            )}
                          </div>
                          {(t.links?.length > 0 || t.url || t.writeup_url) && (
                            <div className="mats">
                              {/* The prep write-up, sitting with the case and
                                  the Canvas link rather than buried inside the
                                  row, as a Google Doc that opens like the
                                  other files. First, because on a class task
                                  it is the thing opened most. */}
                              {t.writeup_url && (
                                <a
                                  href={t.writeup_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="mat prep"
                                  title="Your prep write-up, as a Google Doc"
                                >
                                  Prep
                                </a>
                              )}
                              {t.links?.map((l) => (
                                <a
                                  key={l.href}
                                  href={l.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={`mat ${l.kind}`}
                                  title={l.label}
                                >
                                  {matLabel(l)}
                                </a>
                              ))}
                              {t.url && (
                                <a href={t.url} target="_blank" rel="noopener noreferrer" className="mat plain">
                                  Canvas
                                </a>
                              )}
                            </div>
                          )}

                          {open[t.id] && (
                            <div className="detail">
                              {/* The question as Canvas wrote it, behind its own
                                  disclosure.

                                  It used to render inline, which meant opening
                                  any task dropped a full prep question into the
                                  middle of a list being scrolled, which was
                                  far too crowded; a dropdown fixes that. The
                                  numbering and line breaks are still kept —
                                  they are most of what an HBS question is — but
                                  they only appear once you ask for them. */}
                              {t.prompt ? (
                                <details className="qdrop">
                                  <summary>
                                    The question
                                    <span className="wcount">
                                      {t.prompt.split('\n').filter((l) => l.trim()).length} lines
                                    </span>
                                  </summary>
                                  <div className="prompt">
                                    {t.prompt.split(/\n{2,}/).map((para, n) => (
                                      <p key={n}>
                                        {para.split('\n').map((line, m) => (
                                          <Fragment key={m}>
                                            {m > 0 && <br />}
                                            {line}
                                          </Fragment>
                                        ))}
                                      </p>
                                    ))}
                                  </div>
                                </details>
                              ) : t.notes ? (
                                <p>{trimNotes(t.notes)}</p>
                              ) : (
                                <p className="muted">Canvas gave no description for this assignment.</p>
                              )}

                              {/* The write-up as text, only when there is no
                                  Google Doc to open instead — before the Drive
                                  scope is granted, or when an upload failed.
                                  Once the "Prep" link is up at the top of the
                                  row, repeating twenty thousand characters down
                                  here is exactly the crowding the dropdown removed. */}
                              {t.writeup && !t.writeup_url && (
                                <details className="writeup">
                                  <summary>
                                    Your prep write-up
                                    <span className="wcount">
                                      {Math.round(t.writeup.length / 1000)}k characters
                                      {t.writeup_at
                                        ? ` · written ${new Date(t.writeup_at).toLocaleDateString('en-US', {
                                            month: 'short',
                                            day: 'numeric',
                                          })}`
                                        : ''}
                                    </span>
                                  </summary>
                                  <div className="prompt">
                                    {t.writeup.split(/\n{2,}/).map((para, n) => (
                                      <p key={n}>
                                        {para.split('\n').map((line, m) => (
                                          <Fragment key={m}>
                                            {m > 0 && <br />}
                                            {line}
                                          </Fragment>
                                        ))}
                                      </p>
                                    ))}
                                  </div>
                                </details>
                              )}

                              <TaskResponse task={t} onSave={patch} disabled={state.seeded} />

                              {t.links.length > 1 && (
                                <dl className="mats-key">
                                  {t.links.map((l) => (
                                    <div key={l.href}>
                                      <dt><a href={l.href} target="_blank" rel="noopener noreferrer">{matLabel(l)}</a></dt>
                                      <dd>{matKind(l)}</dd>
                                    </div>
                                  ))}
                                </dl>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="ctl">
                          {/**
                            * The deadline, editable in place.
                            *
                            * It could be set when adding a task and never
                            * afterwards, so a to-do created with the wrong
                            * time — or none — was stuck that way.
                            *
                            * Only on tasks you own. Canvas owns the deadline
                            * on a mirrored row and the API refuses to change
                            * it, so offering the control there would be an
                            * input that silently does nothing.
                            */}
                          {t.origin === 'owned' && (
                            <input
                              type="datetime-local"
                              className="whenedit"
                              aria-label={`Deadline for ${t.title}`}
                              value={t.due_at ? toLocalInput(t.due_at) : ''}
                              disabled={state.seeded}
                              onChange={(e) => patch(t.id, {
                                due_at: e.target.value ? new Date(e.target.value).toISOString() : null,
                              })}
                            />
                          )}

                          {/* Priority. Three states plus "auto", cycled by
                              clicking, because a select here would be four
                              taps on a phone for a one-bit decision. */}
                          <button
                            className={`pri p${t.priority ?? 0}`}
                            title={priTitle(t.priority)}
                            aria-label={priTitle(t.priority)}
                            disabled={state.seeded}
                            onClick={() => patch(t.id, { priority: nextPriority(t.priority) })}
                          >
                            {t.priority == null ? '—' : ['', 'High', 'Norm', 'Low'][t.priority]}
                          </button>

                          <select
                            className="recat"
                            aria-label={`Category for ${t.title}`}
                            value={t.category}
                            disabled={state.seeded}
                            onChange={(e) => patch(t.id, { category: e.target.value })}
                            style={{ color: t.course ? COURSE_VAR[t.course] : CAT_VAR[t.category] }}
                          >
                            {CATEGORIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}
                          </select>

                          <select
                            className="recat"
                            aria-label={`Class for ${t.title}`}
                            value={t.course ?? ''}
                            disabled={state.seeded}
                            onChange={(e) => patch(t.id, { course: e.target.value || null })}
                          >
                            <option value="">—</option>
                            {COURSES.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>

                          {/* Manual order. Moving a task pins it above the
                              formula; "Auto" hands it back to the ranking. */}
                          <span className="ord">
                            <button
                              aria-label={`Move ${t.title} up`} title="Move up" disabled={state.seeded || i === 0}
                              onClick={() => patch(t.id, { sort_order: orderAbove(visible, i) })}
                            >↑</button>
                            <button
                              aria-label={`Move ${t.title} down`} title="Move down"
                              disabled={state.seeded || i === visible.length - 1}
                              onClick={() => patch(t.id, { sort_order: orderBelow(visible, i) })}
                            >↓</button>
                            {t.sort_order != null && (
                              <button
                                className="unpin" title="Back to automatic order" aria-label="Back to automatic order"
                                onClick={() => patch(t.id, { sort_order: null })}
                              >auto</button>
                            )}
                          </span>
                        </div>
                      </li>
                      </Fragment>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <section>
              <h2 className="sec">Week <span className="count">where it fits</span></h2>
              <div className="week">
                {weekDays(nowMs).map((d) => {
                  const evs = onCalendar.filter((e) => sameDay(e.start_at, d));
                  const placed = tasks.filter(
                    (t) => !t.done && t.work_opens_at && sameDay(t.work_opens_at, d),
                  );
                  const busy = evs.reduce((m, e) => m + durationMin(e), 0);
                  const free = Math.max(0, 14 * 60 - busy);
                  const need = placed.reduce((m, t) => m + (t.est_minutes ?? 0), 0);
                  return (
                    <div key={d} className={sameDay(new Date(d).toISOString(), nowMs) ? 'day today' : 'day'}>
                      <h3>
                        {new Date(d).toLocaleDateString([], { weekday: 'short' })}{' '}
                        <em>{new Date(d).getDate()}</em>
                      </h3>
                      {evs.map((e) => {
                        const c = courseOf(e.title);
                        const prep = prepFor(e, c, state.tasks);
                        return (
                          <span className="chip" key={e.id} style={{ color: c ? COURSE_VAR[c] : undefined }}>
                            <b>{hhmm(e.start_at)}</b> {e.title}
                            {/* The case links, in the week view too — this is
                                where you plan the evening before. */}
                            {prep.flatMap((t) => t.links.filter((l) => l.kind === 'case')).slice(0, 2).map((l) => (
                              <a key={l.href} href={l.href} target="_blank" rel="noreferrer"
                                 className="mat case" title={l.label}>Case</a>
                            ))}
                          </span>
                        );
                      })}
                      {placed.map((t) => (
                        <span className="chip" key={t.id} style={{ borderLeft: `2px solid ${t.course ? COURSE_VAR[t.course] : CAT_VAR[t.category]}` }}>
                          {t.title}{t.est_minutes ? ` · ${t.est_minutes}m` : ''}
                        </span>
                      ))}
                      {need > free && <div className="over">Over capacity by {need - free} min</div>}
                    </div>
                  );
                })}
              </div>
              <p className="empty">Drag-to-reschedule arrives at build step 4.</p>
            </section>
          )}

          {/* Housekeeping, last. */}
          <section className="agent">
            <div className="agent-head">
              <span className={`pulse${state.worker_offline ? ' off' : ''}`} />
              Calendar Reconciliation
              <span className="when">
                {state.last_run
                  ? `Finished ${hhmm(state.last_run.finished_at)}${state.last_run.next_run_at ? ` · next run ${hhmm(state.last_run.next_run_at)}` : ''}`
                  : 'Has never run'}
              </span>
            </div>

            {state.last_run && state.last_run.did.length > 0 && (
              <div className="did">
                <ul>{state.last_run.did.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}

            {pending.length === 0 ? (
              <div className="resolved">
                Nothing waiting on you.
                {state.last_run?.next_run_at ? ` Next run at ${hhmm(state.last_run.next_run_at)}.` : ''}
              </div>
            ) : (
              pending.map((a) => (
                <div className="ask" key={a.id}>
                  <div className="body">
                    <p className="t">{a.summary}</p>
                    <p className="d">{a.detail}</p>
                    {a.preview && <p className="pv">{a.preview}</p>}

                    {/* A note travels with the decision. Where the action
                        creates a calendar entry it is written into that
                        entry's body, so the reason sits next to the thing
                        rather than in a log nobody will ever open. */}
                    <input
                      className="asknote"
                      placeholder="Add a note (optional) — goes into the calendar entry"
                      aria-label={`Note for: ${a.summary}`}
                      maxLength={500}
                      value={notes[a.id] ?? ''}
                      disabled={state.seeded || !!busy[a.id]}
                      onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                    />

                    {busy[a.id] && <p className="d" style={{ color: 'var(--ok)' }}>{busy[a.id]}</p>}
                  </div>
                  <div className="btns">
                    {/* A calendar mismatch has two real answers, not yes/no —
                        it is still on, or it was cancelled. */}
                    {a.type === 'mirror_to_outlook' ? (
                      <>
                        <button className="btn-ok" disabled={state.seeded || !!busy[a.id]}
                                onClick={() => decide(a.id, 'approve', 'Adding to Outlook…')}>
                          Still on
                        </button>
                        <button className="btn-no" disabled={state.seeded || !!busy[a.id]}
                                onClick={() => decide(a.id, 'remove', 'Removing from Google…')}>
                          Cancelled
                        </button>
                      </>
                    ) : (
                      <button className="btn-ok" disabled={state.seeded || !!busy[a.id]}
                              onClick={() => decide(a.id, 'approve', 'Queued for the worker…')}>
                        {a.type === 'send_email' ? 'Review draft' : 'Approve'}
                      </button>
                    )}
                    <button className="btn-no" disabled={state.seeded || !!busy[a.id]}
                            onClick={() => decide(a.id, 'skip', 'Skipped')}>
                      Skip
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
        </main>

        {/* A jump bar, phone only.
            The console is one long column on a phone — to-do list, calendar,
            recruiting, email, participation, sources — and getting from the
            top to participation meant a lot of thumb. CSS hides this entirely
            above 720px, where the two columns already put everything within
            a screen or two. */}
        <nav className="jump" aria-label="Jump to a section">
          <a href="#todo">To do</a>
          <a href="#calendar">Calendar</a>
          <a href="#recruiting">Recruiting</a>
          <a href="#email">Email</a>
          <a href="#participation">Speaking</a>
          <a href="#sources">Sources</a>
        </nav>

        {/* The chat is its own grid child rather than the rail's first item.
            On a wide screen CSS puts it back at the top of the right column,
            exactly where it was. On a phone the columns stack, and it has to
            come FIRST and stay put while everything scrolls under it — which
            it cannot do nested inside a rail that sits below the to-do list.
            One component, placed by CSS, rather than two that could drift. */}
        <div className="agentwrap">
          <AgentChat disabled={state.seeded} onDone={() => { void load(); }} />
        </div>

        <aside className="rail" ref={railRef}>

          <div className="box">
            <h2 className="sec" id="recruiting">
              New 12Twenty events
              {twentyEvents(state).length > 0 && (
                <span className="count">{twentyEvents(state).length}</span>
              )}
            </h2>
            {twentyEvents(state).length === 0 ? (
              <div className="empty pend">
                Nothing new in the next three weeks in{' '}
                {listOr(targets.industries.map((i) => i.name.toLowerCase()))}. Events you have already registered for are on the calendar
                rather than here, and 12Twenty is checked every three hours.
              </div>
            ) : twentyEvents(state).map((e) => (
              <div className="ev recruit" key={e.id}>
                <b>
                  {e.url
                    ? <a href={e.url} target="_blank" rel="noopener noreferrer">{e.title}</a>
                    : e.title}
                </b>
                <div className="m">
                  {dayLabel(e.start_at)} · {hhmm(e.start_at)}
                  {e.location ? ` · ${e.location}` : ''}
                </div>
                {e.matched_filters.length > 0 && (
                  <div className="why">Matched: {e.matched_filters.join(', ')}</div>
                )}
                {e.registered ? (
                  <div className="flag">Registered</div>
                ) : rsvp[e.id] ? (
                  <div className="flag">{rsvp[e.id]}</div>
                ) : (
                  <div className="rbtns">
                    <button
                      className="linkish"
                      disabled={!!rsvp[e.id]}
                      onClick={() => clearRecruiting(
                        { key: e.id, eventId: e.id, url: e.url, title: e.title, when: '', flag: null, late: false },
                        'register-me',
                      )}
                    >
                      Sign me up
                    </button>
                    <button
                      className="linkish dismiss"
                      onClick={() => clearRecruiting(
                        { key: e.id, eventId: e.id, url: e.url, title: e.title, when: '', flag: null, late: false },
                        'not-relevant',
                      )}
                    >
                      Not relevant
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="box">
            <h2 className="sec" id="email">
              Priority email
              {mail('priority').length > 0 && <span className="count">{mail('priority').length}</span>}
              <span className="spacer" />
              {/* Mail cleared in Outlook should not have to be cleared
                  again here. The laptop does the reading, so this asks. */}
              <button
                className="linkish"
                onClick={() => void refreshMail()}
                disabled={state.seeded || mailRefresh === 'asked'}
                title="Asks the laptop to re-read your mailbox now"
              >
                {mailRefresh === 'asked' ? 'Re-reading…' : 'Refresh'}
              </button>
            </h2>
            {mail('priority').length === 0 ? (
              <div className="empty pend">Nothing in the last week that looks like it wants a reply.</div>
            ) : mail('priority').slice(0, 5).map((m) => (
              <MailRow key={m.id} item={m} onHandled={() => handleMail(m.id)}
                        onNotRelevant={() => handleMail(m.id, 'not_relevant')}
                        onAddTask={() => addMailTask(m)} added={Boolean(mailTasked[m.id])} />
            ))}
          </div>

          <div className="box">
            <h2 className="sec">
              New roles
              {openRoles > 0 && <span className="count">{openRoles}</span>}
              <span className="spacer" />
              <a className="linkish" href="/internships">Tracker →</a>
            </h2>
            {openRoles === 0 ? (
              <div className="empty pend">
                Nothing matching this week. Roles come from LinkedIn&apos;s own alert emails and
                from company job boards — neither is scraped.
              </div>
            ) : (
              <>
                {state.jobs.slice(0, 6).map((j) => (
                  <div
                    className={`ev mailrow${j.expired_at ? ' closed' : ''}`}
                    key={j.id}
                    title={j.reasons.join(' · ')}
                  >
                    <b><a href={j.url} target="_blank" rel="noopener noreferrer">{j.title}</a></b>
                    <div className="m">
                      {j.company}{j.location ? ` · ${j.location}` : ''}
                      {/* Said plainly rather than implied by position. You
                          should not have to infer from the ordering that a
                          role has closed, and the link still goes somewhere. */}
                      {j.expired_at && <span className="gone"> · no longer listed</span>}
                    </div>
                    {j.reasons.length > 0 && <div className="why">{j.reasons.join(' · ')}</div>}
                    <div className="jbtns">
                      {/* The link the two halves never had. A role found on a
                          job board can now reach the tracker you work from. */}
                      <button className="linkish" onClick={() => void trackJob(j)}>
                        {tracked[j.id] ? 'In your tracker' : 'Track it'}
                      </button>
                      <button className="linkish" onClick={() => void markJob(j.id, 'applied')}>
                        Applied
                      </button>
                      <button className="linkish dismiss" onClick={() => void markJob(j.id, 'dismissed')}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
                {mail('linkedin_role').slice(0, 6).map((m) => (
                  <MailRow key={m.id} item={m} onHandled={() => handleMail(m.id)}
                            onNotRelevant={() => handleMail(m.id, 'not_relevant')}
                        onAddTask={() => addMailTask(m)} added={Boolean(mailTasked[m.id])} />
                ))}
              </>
            )}

            {/* What is being filtered for, from lib/targets.json — the same
                file the worker scores against, so the description and the
                filter cannot disagree. */}
            <details className="targets">
              <summary>{targets.timing} · what this is filtering for</summary>
              <div className="tgrp">
                <span className="tlab">Functions</span>
                {targets.functions.map((f) => <span className="chip" key={f.name}>{f.name}</span>)}
              </div>
              <div className="tgrp">
                <span className="tlab">Industries</span>
                {targets.industries.map((i) => <span className="chip" key={i.name}>{i.name}</span>)}
              </div>
              <div className="tgrp">
                <span className="tlab">Cities</span>
                {cityChips().map((c) => <span className="chip" key={c}>{c}</span>)}
              </div>
              <p className="tnote">
                {targets.remote_is_a_target ? 'Remote counts.' : 'Not remote.'}
                {targets.exclude.terms.length > 0 &&
                  ` Skips ${targets.exclude.terms.slice(0, 4).join(', ')}${targets.exclude.terms.length > 4 ? '…' : ''}.`}
              </p>
            </details>
          </div>

          <div className="box">
            <h2 className="sec">Worth reading</h2>
            {mail('news').length === 0 ? (
              <div className="empty pend">
                Nothing from your newsletters this week that touches what you are working
                towards. This only reads what already arrives in your inbox.
              </div>
            ) : mail('news').slice(0, 5).map((m) => (
              <MailRow key={m.id} item={m} onHandled={() => handleMail(m.id)}
                            onNotRelevant={() => handleMail(m.id, 'not_relevant')}
                        onAddTask={() => addMailTask(m)} added={Boolean(mailTasked[m.id])} />
            ))}
          </div>

          <div className="box">
            <h2 className="sec">Contacts to reach out to</h2>
            {mail('contact').length === 0 ? (
              <div className="empty pend">
                No one new. CPD emails and LinkedIn invitations land here, with a draft note —
                drafted, never sent.
              </div>
            ) : mail('contact').slice(0, 5).map((m) => (
              <MailRow key={m.id} item={m} onHandled={() => handleMail(m.id)}
                            onNotRelevant={() => handleMail(m.id, 'not_relevant')}
                        onAddTask={() => addMailTask(m)} added={Boolean(mailTasked[m.id])} />
            ))}

            {/* Actual people, from 12Twenty's mentorship directory.

                Above the LinkedIn searches on purpose: everyone here opted in
                to being contacted, so an approach is what they signed up for,
                while a LinkedIn search is a cold start. Scored on whether they
                already do the work you want — the reasons are shown, because
                a ranking you cannot argue with is one you stop trusting. */}
            {(state.people ?? []).length > 0 && (
              <div className="netfind">
                <h3 className="sub">From 12Twenty networking</h3>
                {(state.people ?? []).slice(0, 6).map((p) => (
                  <div className="person" key={p.id}>
                    <b>
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a>
                      ) : p.name}
                    </b>
                    <div className="prole">
                      {p.title}
                      {p.employer ? ` · ${p.employer}` : ''}
                    </div>
                    <div className="pwhy">
                      {p.reasons.join(' · ')}
                      {p.grad_year ? ` · MBA ${p.grad_year}` : ''}
                    </div>
                    {/* Three decisions, and each one teaches. Rules cannot tell
                        that a robotics startup is industrials tech and a
                        hospital group is not — the industry is often not in
                        the name — so you teach it instead, and the words of
                        whoever you pass on become a penalty on the next one that looks alike. */}
                    <div className="pbtns">
                      <button className="linkish" onClick={() => void decidePerson(p, 'to_contact')}>
                        Flag for outreach
                      </button>
                      <button className="linkish" onClick={() => void decidePerson(p, 'contacted')}>
                        Reached out
                      </button>
                      <button className="linkish mute" onClick={() => void decidePerson(p, 'not_interested')}>
                        Not interested
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Where to find people, built from the companies you have actually
                engaged with — an event you registered for first, a job posting
                second. These are LINKS, not automation: see lib/networking.ts
                for why LinkedIn is never driven on your behalf. */}
            {network.length > 0 && (
              <details className="netfind folded">
                {/* Collapsed, since LinkedIn reading is off. Kept rather than
                    deleted: the searches are only URLs, they cost nothing
                    while closed, and they are still right if it is turned back on.
                    The 12Twenty people above are the better source anyway —
                    those have agreed to be contacted. */}
                <summary className="sub">
                  LinkedIn searches
                  <span className="netcount">{network.length} companies</span>
                </summary>
                {network.map((t) => (
                  <details className="nettarget" key={t.company}>
                    <summary>
                      {t.company}
                      <span className="netwhy">{t.why}</span>
                    </summary>
                    <div className="netlinks">
                      {t.searches.map((s) => (
                        <a key={s.href} href={s.href} target="_blank" rel="noopener noreferrer">
                          {s.label}
                        </a>
                      ))}
                    </div>
                  </details>
                ))}
                <p className="netnote">
                  LinkedIn searches, opened in your browser. Nothing here signs in or reads
                  LinkedIn — that would risk the account you are recruiting with.
                </p>
              </details>
            )}
          </div>

          <div className="box">
            <h2 className="sec">
              Recruiting deadlines <span className="count">next 10 days</span>
            </h2>
            {recruitingRail(state, tasks, nowMs).length === 0 ? (
              <div className="empty">
                No recruiting deadlines in the next 10 days. New events are in the
                12Twenty panel above.
              </div>
            ) : (
              recruitingRail(state, tasks, nowMs).map((r) => (
                <div className="ev recruit" key={r.key}>
                  <b>
                    {r.url
                      ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a>
                      : r.title}
                  </b>
                  <div className="m">{r.when}</div>
                  {r.flag && <div className={`flag${r.late ? ' late' : ''}`}>{r.flag}</div>}
                  {/* Two real outcomes, not one. Either you signed up, or it
                      was never for you — and "done" cannot express the second. */}
                  <div className="rbtns">
                    {/* Three things you might want: go and look, have it done
                        for you, or never see it again. */}
                    {r.url && (
                      <a className="linkish" href={r.url} target="_blank" rel="noopener noreferrer">
                        Open
                      </a>
                    )}
                    {r.eventId && (
                      <button className="linkish" onClick={() => clearRecruiting(r, 'register-me')}>
                        Sign me up
                      </button>
                    )}
                    <button className="linkish" onClick={() => clearRecruiting(r, 'registered')}>
                      Already registered
                    </button>
                    <button className="linkish dismiss" onClick={() => clearRecruiting(r, 'not-relevant')}>
                      Not relevant
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="box">
            <h2 className="sec" id="participation">
              Participation
              <span className="count">from your Class Log</span>
            </h2>
            {state.participation.every((p) => p.total_sessions === 0) ? (
              <div className="empty pend">
                No sessions logged yet. This reads the Class Log tab of your master
                tracker — it never writes to it, and it never invents a session.
              </div>
            ) : (
              <table className="ptable">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Spoke</th>
                    <th>Since</th>
                    <th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {[...state.participation]
                    .sort((a, b) => b.sessions_since_spoke - a.sessions_since_spoke
                      || a.course.localeCompare(b.course))
                    .map((p) => (
                      <tr
                        key={p.course}
                        title={[
                          p.last_type ? `Last contribution: ${p.last_type}` : null,
                          p.logged_sessions < p.total_sessions
                            ? `Class Log has ${p.logged_sessions} of ${p.total_sessions} sessions — the rest are counted as not spoken`
                            : null,
                        ].filter(Boolean).join(' · ') || undefined}
                      >
                        <td><span style={{ color: COURSE_VAR[p.course] }}>{p.course}</span></td>
                        <td>
                          {p.total_sessions ? `${p.spoke_count} of ${p.total_sessions}` : '—'}
                          {/* The log being behind is the difference between
                              "spoke in 1 of 1" and "spoke in 1 of 4". */}
                          {p.logged_sessions < p.total_sessions && <span className="gap"> ·log {p.logged_sessions}</span>}
                        </td>
                        {/* The number that actually predicts a cold call. */}
                        <td className={p.sessions_since_spoke >= p.goal_every ? 'hot' : undefined}>
                          {p.total_sessions === 0 ? '—' : p.sessions_since_spoke}
                        </td>
                        <td className="pwhen">
                          {p.last_spoke_at
                            ? new Date(p.last_spoke_at).toLocaleDateString([], { day: 'numeric', month: 'short' })
                            : 'never'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Google is the master; Outlook is the follower you update by
              hand, because HBS blocks every route to writing it. The gap is
              stated plainly rather than left to be discovered on your phone. */}
          {outlookGaps.length > 0 && (
            <div className="box">
              <h2 className="sec">
                Outlook needs you <span className="count">{outlookGaps.length}</span>
              </h2>
              <p className="outnote">
                Changed here and saved to Google. Outlook has no way in, so these need
                doing there by hand — they clear themselves once Outlook agrees.
              </p>
              <ul className="outlist">
                {outlookGaps.map((e) => (
                  <li key={e.id}>
                    <b>{e.title}</b>
                    <span className="when">
                      {new Date(e.start_at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
                      {' · '}{hhmm(e.start_at)}{e.end_at ? `–${hhmm(e.end_at)}` : ''}
                    </span>
                    <span className="ask">{e.outlook_needs}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="box">
            <h2 className="sec" id="sources">Sources</h2>
            {state.sources.map((s) => (
              <div className="src" key={s.name} title={s.last_error ?? undefined}>
                <span className="dot" style={{ background: dotColor(s.status) }} />
                <span className="nm">{sourceName(s.name)}</span>
                <span className="st">
                  {s.last_sync_at ? `synced ${hhmm(s.last_sync_at)}` : 'never synced'}
                </span>
              </div>
            ))}
            <div className="src">
              <span className="dot" style={{ background: 'var(--ink-3)' }} />
              <span className="nm">LinkedIn</span>
              <span className="st">Via email alerts only</span>
            </div>
          </div>
        </aside>
      </div>

      <footer>
        {state.seeded
          ? 'Sample data — nothing here is pulled from your real accounts.'
          : `Live. Worker last checked in ${state.worker_last_beat ? relative(state.worker_last_beat, nowMs) : 'never'}.`}
      </footer>
    </div>
  );
}

/* ---------------- helpers ---------------- */

function byStart(a: CalEvent, b: CalEvent) { return Date.parse(a.start_at) - Date.parse(b.start_at); }

function sameDay(iso: string, ref: number): boolean {
  const d = new Date(iso); const n = new Date(ref);
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function durationMin(e: CalEvent): number {
  const s = Date.parse(e.start_at);
  const end = e.end_at ? Date.parse(e.end_at) : s + 3600_000;
  return Math.max(0, Math.round((end - s) / 60_000));
}

function isCurrent(e: CalEvent, nowMs: number): boolean {
  const s = Date.parse(e.start_at);
  const end = e.end_at ? Date.parse(e.end_at) : s + 3600_000;
  return s <= nowMs && nowMs < end;
}

function isPast(e: CalEvent, nowMs: number): boolean {
  const end = e.end_at ? Date.parse(e.end_at) : Date.parse(e.start_at) + 3600_000;
  return end <= nowMs;
}

function nextEvent(events: CalEvent[], nowMs: number): CalEvent | null {
  const upcoming = events
    .filter((e) => sameDay(e.start_at, nowMs))
    .filter((e) => !isPast(e, nowMs))
    .sort(byStart);
  return upcoming[0] ?? null;
}

/**
 * "MKT X" → MKT: a configured course code at the start of the title.
 * Discussion Group and club events return null. The regex comes from
 * useCourseRe(), so it is passed in rather than built here.
 */
function courseIn(title: string, re: RegExp): Course | null {
  const m = re.exec(title.trim());
  return m && m.index === 0 ? (m[1].toUpperCase() as Course) : null;
}

function riskOf(p: Participation): ColdCallRisk {
  if (p.sessions_since_spoke >= p.goal_every) return 'high';
  if (p.sessions_since_spoke === p.goal_every - 1) return 'medium';
  return 'low';
}

function spokeLabel(p: Participation): string {
  if (p.sessions_since_spoke === 0) return 'you spoke last session';
  if (p.sessions_since_spoke === 1) return 'last spoke 1 session ago';
  return `last spoke ${p.sessions_since_spoke} sessions ago`;
}

function spokeShort(p: Participation): string {
  return p.sessions_since_spoke === 0 ? 'just now' : `${p.sessions_since_spoke} ago`;
}

function untilLabel(iso: string, nowMs: number): string {
  const mins = Math.round((Date.parse(iso) - nowMs) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  return `in ${h}h ${mins % 60}m`;
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dueHot(iso: string, nowMs: number): boolean {
  return Date.parse(iso) - nowMs < 48 * 3600_000;
}

function dueLabel(iso: string, nowMs: number): string {
  const ms = Date.parse(iso) - nowMs;
  const h = ms / 3600_000;
  if (h < 0) return 'Overdue';
  if (h < 12) return `Due ${hhmm(iso)}`;
  if (h < 24) return 'Due tonight';
  const days = Math.round(h / 24);
  return days === 1 ? 'Due tomorrow' : `${days} days`;
}

function relative(iso: string, nowMs: number): string {
  const mins = Math.round((nowMs - Date.parse(iso)) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function weekDays(nowMs: number): number[] {
  const out: number[] = [];
  const d = new Date(nowMs); d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) { out.push(d.getTime()); d.setDate(d.getDate() + 1); }
  return out;
}


interface RailRow {
  /** Where to go to actually do it. */
  url?: string | null;
  /** The task behind the row, when ticking it off means completing a task. */
  taskId?: string | null;
  /** The event behind the row, when it is a 12Twenty session. */
  eventId?: string | null; key: string; title: string; when: string; flag: string | null; late: boolean; }

function recruitingRail(state: ConsoleState, tasks: Task[], nowMs: number): RailRow[] {
  const horizon = nowMs + 10 * 86_400_000;
  const rows: RailRow[] = [];

  for (const t of tasks) {
    if (t.category !== 'recruiting' || t.done || !t.due_at) continue;
    const due = Date.parse(t.due_at);
    if (due > horizon) continue;
    rows.push({
      key: `t-${t.id}`,
      taskId: t.id,
      url: t.url,
      title: t.title,
      when: `${new Date(due).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${hhmm(t.due_at)}`,
      flag: dueHot(t.due_at, nowMs) ? 'Due inside 48 hours' : null,
      late: dueHot(t.due_at, nowMs),
    });
  }

  for (const e of state.events) {
    // 12Twenty sessions belong to the 12Twenty panel, which is where you sign
    // up or dismiss them. Listing them here too put every event on the page
    // twice with a different set of buttons on each copy.
    if (e.source !== 'email') continue;
    if (e.recruiting_dismissed) continue;
    const s = Date.parse(e.start_at);
    if (s < nowMs || s > horizon) continue;
    rows.push({
      key: `e-${e.id}`,
      eventId: e.id,
      url: e.url,
      title: e.title,
      when: `${new Date(s).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${hhmm(e.start_at)}${e.location ? ` · ${e.location}` : ''}`,
      flag: e.registered ? 'Registered' : 'Not registered',
      late: false,
    });
  }

  return rows.sort((a, b) => a.when.localeCompare(b.when)).slice(0, 6);
}

function dotColor(status: string): string {
  if (status === 'ok') return 'var(--ok)';
  if (status === 'error') return 'var(--alert)';
  return 'var(--warn)';
}

function sourceName(n: string): string {
  if (n === 'gcal') return 'Google Calendar';
  if (n === 'gmail') return 'Gmail';
  if (n === '12twenty') return '12Twenty';
  return cap(n);
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** "a, b or c" — for copy built from lib/targets.json. */
function listOr(xs: string[]): string {
  if (xs.length === 0) return 'your target industries';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

/** "cambridge, ma" → "Cambridge, MA". Two-letter words are taken as abbreviations. */
function titleCase(s: string): string {
  return s.split(/\s+/).map((w) => (w.replace(/\W/g, '').length <= 2
    ? w.toUpperCase()
    : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/**
 * The cities being filtered for, from lib/targets.json: the first primary
 * term (the rest are usually aliases of it, like "nyc") and every secondary.
 */
function cityChips(): string[] {
  const { primary, secondary } = targets.locations;
  return [...new Set([primary[0], ...secondary].filter(Boolean).map(titleCase))];
}

/**
 * Short label for a materials link. The raw anchor text from Canvas is often
 * the full case title, which is already the task title — so name the kind
 * instead, and keep the original on hover.
 */
/**
 * The assignments belonging to one class session.
 *
 * Canvas dates an assignment to the session it is prepared for, so a class
 * event and its prep share a calendar day and a course. That is the whole
 * join — no cleverness, and nothing invented: if Canvas has no assignment for
 * the session, nothing is shown rather than a guess.
 *
 * Done items stay visible but struck through. Knowing the case is read is
 * part of walking into the room.
 */
function prepFor(ev: CalEvent, course: Course | null, tasks: Task[]): Task[] {
  if (!course) return [];
  const day = new Date(ev.start_at).toDateString();

  return tasks
    .filter((t) => t.course === course && t.due_at && new Date(t.due_at).toDateString() === day)
    .sort((a, b) => {
      // Cases first — they are the thing you must have read.
      const ac = a.links.some((l) => l.kind === 'case') ? 0 : 1;
      const bc = b.links.some((l) => l.kind === 'case') ? 0 : 1;
      return ac - bc || a.title.localeCompare(b.title);
    });
}

/**
 * What a material actually is, for the expanded key.
 *
 * Canvas does not say, so this is inferred from where the link points — which
 * is honest as far as it goes, and stops short of guessing at content.
 */
function matKind(l: TaskLink): string {
  if (l.kind === 'case') return 'HBP case — opens in Harvard Business Publishing';
  if (l.kind === 'harvard-online') return 'Harvard Online content';
  if (l.kind === 'canvas-file') {
    const n = l.label.toLowerCase();
    if (/podcast|script|transcript/.test(n)) return 'Canvas file — podcast or transcript';
    if (/slide|deck|exhibit/.test(n)) return 'Canvas file — slides or exhibits';
    if (/data|spreadsheet|xls/.test(n)) return 'Canvas file — data';
    return 'Canvas file';
  }
  if (/^\[video\]$/i.test(l.label.trim())) return 'Embedded video';
  return 'Link';
}

/**
 * What you plan to say about this assignment.
 *
 * Kept in the same dropdown as the question, because a prepared response only
 * means anything next to the thing it answers. It is a draft, so it saves on a
 * button rather than on every keystroke — and the button says whether it
 * saved, because a silent save is indistinguishable from a lost one.
 *
 * The local draft is seeded from the row and only reset when the stored value
 * actually changes, so a background reload of state cannot wipe what you are
 * part-way through typing.
 */
function TaskResponse({
  task, onSave, disabled,
}: {
  task: Task;
  onSave: (id: string, body: Record<string, unknown>) => Promise<void>;
  disabled: boolean;
}) {
  const stored = task.response ?? '';
  const [text, setText] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const lastStored = useRef(stored);

  useEffect(() => {
    if (lastStored.current !== stored) {
      lastStored.current = stored;
      setText(stored);
    }
  }, [stored]);

  const dirty = text !== stored;

  async function save() {
    setSaving(true);
    setSaved(false);
    await onSave(task.id, { response: text });
    setSaving(false);
    setSaved(true);
  }

  return (
    <div className="resp">
      <label htmlFor={`r-${task.id}`}>
        What you plan to say
        {task.response_at && !dirty && (
          <span className="respwhen"> · written {new Date(task.response_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
        )}
      </label>
      <textarea
        id={`r-${task.id}`}
        rows={4}
        value={text}
        disabled={disabled}
        placeholder="The point you want to make, and which question it answers."
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
      />
      <div className="respctl">
        <button className="btn-ok" disabled={disabled || saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        {saved && !dirty && <span className="respok" role="status">Saved.</span>}
        {disabled && <span className="muted">Sample data — nothing to save to.</span>}
      </div>
    </div>
  );
}

/** Canvas descriptions are HTML-stripped but still long. Show the opening. */
function trimNotes(notes: string): string {
  const s = notes.replace(/\s+/g, ' ').trim();
  return s.length > 600 ? s.slice(0, 580) + '…' : s;
}

/**
 * The header above a run of tasks sharing a due day, or null mid-run.
 *
 * Reordering by hand breaks the day sequence on purpose — a pinned task sits
 * where you put it regardless of when it is due — so the label is emitted
 * whenever the day *changes*, not on a fixed schedule. A pinned task carried
 * out of its day therefore gets its own header rather than appearing to
 * belong to the day above it.
 */
function groupLabel(list: Task[], i: number, nowMs: number, nextClassDay: string | null): string | null {
  const key = (t: Task) => (t.due_at ? dayKey(Date.parse(t.due_at)) : 'none');
  const k = key(list[i]);
  if (i > 0 && key(list[i - 1]) === k) return null;

  if (k === 'none') return 'No deadline';

  const today = dayKey(nowMs);
  if (k === today) return 'Today';
  if (k === dayKey(nowMs + 86_400_000)) return 'Tomorrow';

  const named = new Date(k + 'T12:00:00').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  if (k === nextClassDay) return `${named} — next class day`;
  if (k < today) return 'Overdue';
  return named;
}

const PRI_LABEL = ['Priority: automatic', 'Priority: high', 'Priority: normal', 'Priority: low'];
function priTitle(p: 1 | 2 | 3 | null): string { return PRI_LABEL[p ?? 0]; }

/** auto -> high -> normal -> low -> auto. */
function nextPriority(p: 1 | 2 | 3 | null): 1 | 2 | 3 | null {
  return p == null ? 1 : p === 1 ? 2 : p === 2 ? 3 : null;
}

/**
 * A sort_order that lands the task immediately above its neighbour.
 *
 * Sparse midpoints, so moving one row rewrites one row. Positions can be
 * unset on either side — an unranked neighbour has no number to sit between —
 * so fall back to a step rather than producing NaN.
 */
function orderAbove(list: Task[], i: number): number {
  const target = list[i - 1]?.sort_order ?? i - 1;
  const above = list[i - 2]?.sort_order ?? target - 1;
  return (target + above) / 2;
}

function orderBelow(list: Task[], i: number): number {
  const target = list[i + 1]?.sort_order ?? i + 1;
  const below = list[i + 2]?.sort_order ?? target + 1;
  return (target + below) / 2;
}

/**
 * What belongs on the calendar: what you are actually committed to.
 *
 * 12Twenty lists everything CPD runs — dozens of sessions in a month, of which
 * a student is typically registered for a handful. Mirroring all of them made
 * the calendar a listing of what HBS is doing that week rather than a picture
 * of your week, and a 3:30pm slot that reads as five-way double-booked when
 * you are going to none of the five is worse than no calendar at all.
 *
 * Nothing is hidden by this. Every unregistered event is still in the 12Twenty
 * panel in the rail, which is where the "Sign me up" and "Not relevant"
 * buttons are. Registering puts it on the calendar; cancelling on 12Twenty
 * takes it back off on the next read, because `registered` is re-read from
 * 12Twenty every pass rather than remembered here.
 *
 * This only ever affects what is drawn. Your real Google and Outlook calendars
 * never receive 12Twenty events at all — reconciliation pairs Outlook against
 * Google and nothing else.
 */
function calendarEvents(events: CalEvent[]): CalEvent[] {
  return events.filter((e) => e.source !== '12twenty' || e.registered);
}

/** Events 12Twenty reported. Empty until the source is built — never filled in. */
function twentyEvents(state: ConsoleState): CalEvent[] {
  const now = Date.now();
  return state.events
    .filter((e) =>
      e.source === '12twenty' &&
      Date.parse(e.start_at) > now &&
      !e.recruiting_dismissed &&
      /**
       * Only things you have not dealt with, and only in your fields.
       *
       * Registered events used to be kept here and marked as such, on the
       * argument that "am I signed up for that?" is worth answering. It is —
       * but not in the panel whose job is to show what is NEW. They are on
       * your calendar, which is the right place to answer that question.
       *
       * Unmatched events were shown too, merely sorted last, so the list
       * filled with banks, asset managers and pharma companies. An event
       * outside the industries in lib/targets.json is not a weaker match;
       * it is a different career.
       */
      !e.registered &&
      e.matched_filters.length > 0 &&
      // 12Twenty leaves cancelled sessions on the list with CANCELLED in the
      // title. Offering to sign you up for one would be worse than useless.
      !/^\s*cancell?ed\b/i.test(e.title))
    // Matching your filters first, then soonest.
    .sort((a, b) =>
      (b.matched_filters.length > 0 ? 1 : 0) - (a.matched_filters.length > 0 ? 1 : 0)
      || Date.parse(a.start_at) - Date.parse(b.start_at))
    .slice(0, 6);
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Local calendar day as YYYY-MM-DD. Not toISOString, which is UTC and shifts
 *  the day for anything after 8pm Eastern. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Name the material, not its type.
 *
 * Canvas gives real names — "Acme Corp", "Acme Corp Podcast Script" — and the old
 * version threw them away in favour of "Case PDF" and "File", which made
 * three distinct documents look like three copies of one. Keep the name,
 * trimmed to a few words; the kind still shows as colour, and the full label
 * is on hover.
 */
function matLabel(l: TaskLink): string {
  const raw = l.label.trim().replace(/\.(pdf|docx?|pptx?|xlsx?)$/i, '');

  // Canvas uses "[video]" and similar for embedded media with no real name.
  if (!raw || /^\[.*\]$/.test(raw)) {
    if (l.kind === 'case') return 'Case';
    if (l.kind === 'canvas-file') return 'File';
    if (l.kind === 'harvard-online') return 'Online';
    return raw.replace(/[[\]]/g, '') || 'Link';
  }

  const words = raw.split(/\s+/);
  const short = words.slice(0, 3).join(' ');
  return (words.length > 3 ? short + '…' : short).slice(0, 26);
}

/**
 * One line of mail in the rail.
 *
 * The reasons it scored where it did are on hover, and the draft note is
 * copyable rather than sendable — there is no send path in this codebase at
 * all, which is stronger than a flag that could be flipped by accident.
 */
function MailRow({ item, onHandled, onNotRelevant, onAddTask, added }:
  { item: EmailItem; onHandled: () => void; onNotRelevant: () => void;
    onAddTask: () => void; added: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="ev mailrow" title={item.reasons.join(' · ')}>
      <b>
        {item.url
          ? <a href={item.url} target="_blank" rel="noopener noreferrer">{item.subject}</a>
          : item.subject}
      </b>
      <div className="m">
        {item.from_name ?? item.from_email ?? 'unknown'} · {dayLabel(item.received_at)}
        {/* Which mailbox, because "why have I not seen this?" has a different
            answer for each — and because replies usually go out from Outlook,
            so an Outlook row is the one you may already have dealt with. */}
        {' · '}<span className={`mbox ${item.source}`}>{item.source === 'outlook' ? 'HBS' : 'Gmail'}</span>
        {/* Where you filed it. You sorted it yourself, so it says more
            about what the message is than the subject usually does. */}
        {item.folder && !/^inbox$/i.test(item.folder) && (
          <span className="fold"> · {item.folder}</span>
        )}
      </div>
      {item.tldr && <p className="tldr">{item.tldr}</p>}
      {item.reasons.length > 0 && (
        <div className="why">{item.reasons.join(' · ')}</div>
      )}
      {item.draft && (
        <button
          className="linkish"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(item.draft!);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied — paste it wherever you like' : 'Copy a draft note'}
        </button>
      )}
      <div className="mailctl">
        {/* The common case: it needs doing, but not now. Making a to-do is
            how it leaves the panel without being forgotten — which is the
            only reason to keep looking at an email you have already read. */}
        <button className="linkish" onClick={onAddTask} disabled={added}>
          {added ? 'Added to your list' : 'Add to to-do'}
        </button>
        <button className="linkish dismiss" onClick={onHandled}>Done with it</button>
        {/* Distinct from Done: this one says the KIND of thing is not wanted,
            which is the only signal worth learning from. */}
        <button className="linkish dismiss" onClick={onNotRelevant}>Not relevant</button>
      </div>
    </div>
  );
}

/**
 * An ISO instant as a <input type="datetime-local"> value.
 *
 * The control wants local wall-clock time with no zone, and `toISOString()`
 * gives UTC — which showed every deadline four hours out and would have
 * written it back four hours wrong again on the first edit.
 */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
