'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalEvent, Course, Task } from '@/lib/types';

/**
 * The calendar.
 *
 * Month, week and day. Week and day are real time grids — blocks sized by
 * duration and positioned by start — because "9:30–10:50" and "9:30, an hour
 * and twenty" are the same fact but only one of them shows a clash.
 *
 * Every edit is optimistic locally and queued for the laptop, which owns both
 * calendars. A block therefore carries its sync state: solid when Google and
 * Outlook agree, hatched while the laptop has yet to apply it. Hiding that
 * would mean the page claiming a change the real calendars had not seen.
 */

export type CalView = 'month' | 'week' | 'day';

/**
 * The grid holds the whole day; the view opens on the part of it that gets used.
 *
 * Starting at 7am meant a 6am flight or a midnight deadline simply had
 * nowhere to be drawn. So the grid runs midnight to midnight and the
 * scroller opens at OPEN_AT — everything is reachable, and nothing unusual
 * is invisible.
 */
const DAY_START = 0;
const DAY_END = 24;
const OPEN_AT = 7;   // where the view sits on load
const OPEN_UNTIL = 22;
/**
 * Tighter than is comfortable to read at a glance, on purpose: the whole
 * 7am–11pm day is 16 hours, and the calendar has to sit inside the height of
 * the right-hand rail. The grid scrolls, so nothing is lost — and it opens
 * scrolled to the current hour rather than to 7am, which is where the day
 * actually is by the time you look.
 */
const PX_PER_HOUR = 34;
const SNAP_MIN = 15;

type Props = {
  events: CalEvent[];
  tasks: Task[];
  nowMs: number;
  courseOf: (title: string) => Course | null;
  courseVar: Record<Course, string>;
  readOnly: boolean;
  /** Match the right rail, so the two columns end level. Null on narrow screens. */
  maxHeight: number | null;
  onCreate: (startISO: string, endISO: string) => void;
  onMove: (id: string, startISO: string, endISO: string) => void;
  onOpen: (ev: CalEvent) => void;
};

export default function Calendar({
  events, tasks, nowMs, courseOf, courseVar, readOnly, maxHeight, onCreate, onMove, onOpen,
}: Props) {
  /**
   * A seven-column week does not fit a phone.
   *
   * At 375px the week grid is 576px of columns behind a horizontal scroll,
   * so the first thing you would see is Monday and a third of Tuesday. The
   * day view is the one that works in a hand; the segmented control is right
   * there when you want the week.
   *
   * Read once, on mount, rather than tracked: switching view out from under
   * you because the phone rotated would be worse than the wrong default.
   */
  const [view, setView] = useState<CalView>(() => {
    if (typeof window === 'undefined') return 'week';
    return window.matchMedia('(max-width: 720px)').matches ? 'day' : 'week';
  });
  const [anchor, setAnchor] = useState<number>(startOfDay(nowMs));
  const [drag, setDrag] = useState<{ id: string; offsetMin: number; dayMs: number; startMin: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);

  // The rail's height minus the chrome above and below the grid, so the two
  // columns finish level. Floor it: below about 240px the grid is unusable
  // and a scrollbar on four visible hours helps nobody.
  /**
   * Only the measured case sets a height here.
   *
   * There used to be a fallback of (OPEN_UNTIL - OPEN_AT) * PX_PER_HOUR for
   * narrow screens — 510px, written as an inline style, which beats any
   * stylesheet. So the phone rule capping the calendar at 300px did nothing
   * and the grid still took two thirds of the screen before a single task
   * appeared. A number that has to change with the viewport belongs in a
   * media query, not in a component that cannot see one.
   */
  /**
   * Capped, not just matched to the rail.
   *
   * Matching the rail was the earlier request — the two columns finishing
   * level reads well — but the rail grew as panels were added and took the
   * calendar past 800px with it, so the to-do list started below the fold.
   * Six hours on screen is enough to plan against; the rest scrolls.
   */
  const bodyHeight = maxHeight ? Math.min(Math.max(240, maxHeight - 96), 420) : null;

  /**
   * Open at the current hour, not at 7am.
   *
   * Once per mount only — re-running it would yank the view back every time
   * the state reloads, including while you are reading Thursday.
   */
  useEffect(() => {
    if (view === 'month' || scrolledOnce.current) return;
    const el = scrollRef.current;
    if (!el) return;
    // Centre on now when now is inside the working day; otherwise open at 7am,
    // because at 11pm "scroll to now" shows an empty midnight.
    const hour = new Date(nowMs).getHours();
    const anchorHour = hour >= OPEN_AT && hour <= OPEN_UNTIL ? hour - 1 : OPEN_AT;
    el.scrollTop = Math.max(0, (anchorHour - DAY_START) * PX_PER_HOUR);
    scrolledOnce.current = true;
  }, [view, nowMs]);

  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    if (view === 'week') {
      const monday = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, i) => monday + i * 86_400_000);
    }
    // Month: whole weeks, so the grid is always rectangular.
    const first = new Date(anchor); first.setDate(1);
    const gridStart = startOfWeek(first.getTime());
    const last = new Date(anchor); last.setMonth(last.getMonth() + 1); last.setDate(0);
    const cells = Math.ceil((startOfDay(last.getTime()) - gridStart) / 86_400_000) + 1;
    return Array.from({ length: Math.ceil(cells / 7) * 7 }, (_, i) => gridStart + i * 86_400_000);
  }, [view, anchor]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) {
      const k = dayKey(Date.parse(e.start_at));
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    for (const list of m.values()) list.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    return m;
  }, [events]);

  /**
   * All-day events laid out as spanning bars across the visible days.
   *
   * Google gives an exclusive end date, so a one-day event ends the next
   * morning; the span is clamped to the days actually on screen so a trip
   * starting last week still shows as a bar running off the left edge.
   *
   * Bars are packed into rows so two overlapping trips do not sit on top of
   * one another.
   */
  const allDayBands = useMemo(() => {
    if (view === 'month') return [];
    const first = days[0];
    const last = days[days.length - 1];
    const rowEnds: number[] = [];

    return events
      .filter((e) => e.all_day)
      .map((ev) => {
        const s = startOfDay(Date.parse(ev.start_at));
        const rawEnd = ev.end_at ? startOfDay(Date.parse(ev.end_at)) : s + 86_400_000;
        const e = Math.max(rawEnd - 86_400_000, s); // exclusive end -> last covered day
        return { ev, s, e };
      })
      .filter(({ s, e }) => e >= first && s <= last)
      .sort((a, b) => a.s - b.s || b.e - a.e)
      .map(({ ev, s, e }) => {
        const col = Math.max(0, Math.round((s - first) / 86_400_000));
        const endCol = Math.min(days.length - 1, Math.round((e - first) / 86_400_000));
        let row = rowEnds.findIndex((end) => end < col);
        if (row === -1) { row = rowEnds.length; rowEnds.push(-1); }
        rowEnds[row] = endCol;
        return { ev, col, span: Math.max(1, endCol - col + 1), row };
      });
  }, [events, days, view]);

  function step(dir: number) {
    const d = new Date(anchor);
    if (view === 'month') d.setMonth(d.getMonth() + dir);
    else if (view === 'week') d.setDate(d.getDate() + 7 * dir);
    else d.setDate(d.getDate() + dir);
    setAnchor(startOfDay(d.getTime()));
  }

  /** Minutes from DAY_START for a pointer position inside a day column. */
  function minutesAt(clientY: number, col: HTMLElement): number {
    const rect = col.getBoundingClientRect();
    const raw = ((clientY - rect.top) / PX_PER_HOUR) * 60;
    const snapped = Math.round(raw / SNAP_MIN) * SNAP_MIN;
    return Math.max(0, Math.min((DAY_END - DAY_START) * 60 - SNAP_MIN, snapped));
  }

  return (
    <section className="cal">
      <div className="calbar">
        <div className="seg" role="group" aria-label="Calendar view">
          {(['day', 'week', 'month'] as CalView[]).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <button className="ghost" onClick={() => step(-1)} aria-label="Previous">←</button>
        <button className="ghost" onClick={() => setAnchor(startOfDay(nowMs))}>Today</button>
        <button className="ghost" onClick={() => step(1)} aria-label="Next">→</button>
        <strong className="caltitle">{rangeLabel(view, anchor, days)}</strong>
      </div>

      {view === 'month' ? (
        <div className="monthgrid">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div className="mh" key={d}>{d}</div>
          ))}
          {days.map((d) => {
            /**
             * All-day entries float to the top of the day, without a time.
             *
             * A birthday has a day, not an instant, so rendering it like an
             * appointment printed "12:00 AM Pat Example's birthday" and
             * sorted it below a 9:30 class — the one thing on that square
             * that is actually about the whole day, buried under the things
             * that are not.
             */
            const all = byDay.get(dayKey(d)) ?? [];
            const list = [...all].sort((a, b) => {
              if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
              return Date.parse(a.start_at) - Date.parse(b.start_at);
            });
            const otherMonth = new Date(d).getMonth() !== new Date(anchor).getMonth();
            return (
              <div
                key={d}
                className={`mc${otherMonth ? ' dim' : ''}${dayKey(d) === dayKey(nowMs) ? ' today' : ''}`}
                onDoubleClick={() => !readOnly && onCreate(at(d, 9 * 60), at(d, 10 * 60))}
              >
                <div className="mcn">{new Date(d).getDate()}</div>
                {list.slice(0, 4).map((e) => (
                  <button
                    className={`mce ${syncClass(e)}${e.all_day ? ' allday' : ''}`}
                    key={e.id}
                    onClick={() => onOpen(e)}
                    style={e.all_day ? undefined : { borderColor: tint(e, courseOf, courseVar) }}
                  >
                    {!e.all_day && <span className="t">{hhmm(e.start_at)}</span>}
                    {e.all_day ? '' : ' '}{e.title}
                  </button>
                ))}
                {list.length > 4 && <div className="mcmore">+{list.length - 4} more</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <>
        {/* Day names and the all-day band sit outside the scroller, the way
            Outlook does it: they stay put while the hours scroll under them. */}
        <div className={`calhead ${view}`}>
          <div className="gcorner" />
          {days.map((d) => (
            <div className={`dh${dayKey(d) === dayKey(nowMs) ? ' today' : ''}`} key={d}>
              {new Date(d).toLocaleDateString([], { weekday: 'short' })}
              <em>{new Date(d).getDate()}</em>
            </div>
          ))}
        </div>

        {allDayBands.length > 0 && (
          <div className={`adband ${view}`}>
            <div className="gcorner" />
            {days.map((d) => <div className="adcell" key={d} />)}
            {/* A single bar per event, spanning the days it covers — a trip
                that runs Friday to Sunday reads as one thing, which is the
                whole reason Outlook puts these in a band rather than a column. */}
            {allDayBands.map(({ ev, col, span, row }) => (
              <button
                key={ev.id}
                className={`adx ${syncClass(ev)}`}
                style={{ gridColumn: `${col + 2} / span ${span}`, gridRow: row + 1 }}
                onClick={() => onOpen(ev)}
                title={ev.title}
              >
                {ev.title}
              </button>
            ))}
          </div>
        )}

        <div
          className="scroller"
          ref={scrollRef}
          style={bodyHeight ? { maxHeight: bodyHeight } : undefined}
        >
        <div className={`timegrid ${view}`} ref={gridRef}>
          <div className="gutter">
            {hours().map((h) => (
              <div className="hr" key={h} style={{ height: PX_PER_HOUR }}>
                <span>{labelHour(h)}</span>
              </div>
            ))}
          </div>

          {days.map((d) => {
            const list = byDay.get(dayKey(d)) ?? [];
            const isToday = dayKey(d) === dayKey(nowMs);
            return (
              <div className="daycol" key={d}>
                <div
                  className="slots"
                  style={{ height: (DAY_END - DAY_START) * PX_PER_HOUR }}
                  onDoubleClick={(e) => {
                    if (readOnly) return;
                    const m = minutesAt(e.clientY, e.currentTarget);
                    onCreate(at(d, DAY_START * 60 + m), at(d, DAY_START * 60 + m + 60));
                  }}
                  onPointerMove={(e) => {
                    if (!drag) return;
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                  }}
                  onPointerUp={(e) => {
                    if (!drag) return;
                    const m = minutesAt(e.clientY, e.currentTarget) - drag.offsetMin;
                    const startMin = Math.max(0, Math.round(m / SNAP_MIN) * SNAP_MIN);
                    const ev = events.find((x) => x.id === drag.id);
                    setDrag(null);
                    if (!ev) return;
                    const dur = durationMin(ev);
                    const s = at(d, DAY_START * 60 + startMin);
                    onMove(ev.id, s, new Date(Date.parse(s) + dur * 60_000).toISOString());
                  }}
                >
                  {hours().map((h) => <div className="slot" key={h} style={{ height: PX_PER_HOUR }} />)}

                  {isToday && nowLine(nowMs)}

                  {layout(list.filter((e) => !e.all_day)).map(({ ev, lane, lanes }) => {
                    const top = ((minsFromStart(ev.start_at) / 60) * PX_PER_HOUR);
                    const h = Math.max(18, (durationMin(ev) / 60) * PX_PER_HOUR - 2);
                    return (
                      <div
                        key={ev.id}
                        className={`block ${syncClass(ev)}${drag?.id === ev.id ? ' dragging' : ''}`}
                        style={{
                          top, height: h,
                          left: `${(lane / lanes) * 100}%`,
                          width: `${(1 / lanes) * 100}%`,
                          borderLeftColor: tint(ev, courseOf, courseVar),
                        }}
                        onClick={() => onOpen(ev)}
                        onPointerDown={(e) => {
                          if (readOnly) return;
                          const col = (e.currentTarget.parentElement as HTMLElement);
                          setDrag({
                            id: ev.id,
                            offsetMin: minutesAt(e.clientY, col) - minsFromStart(ev.start_at),
                            dayMs: d,
                            startMin: minsFromStart(ev.start_at),
                          });
                        }}
                        title={syncTitle(ev)}
                      >
                        {/* Title, then location. The start time is deliberately
                            not repeated — the block's position on the grid
                            already says it, and printing it again was half the
                            clutter. A task link shows as a marker, not a
                            sentence. */}
                        <b>{ev.title}</b>
                        {ev.location && <span>{ev.location}</span>}
                        {ev.task_id && tasks.some((t) => t.id === ev.task_id) && (
                          <i className="forwork" title={tasks.find((t) => t.id === ev.task_id)!.title} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        </div>
        </>
      )}

      <p className="calhint">
        {readOnly
          ? 'Sample data — editing is off.'
          : 'Double-click empty space to add. Drag a block to move it. Changes reach Google and Outlook when the laptop next runs.'}
      </p>
    </section>
  );
}

/* ---------------- helpers ---------------- */

function hours() { return Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i); }
function labelHour(h: number) { return h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`; }

function startOfDay(ms: number) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** Monday-first, which is how a class timetable reads. */
function startOfWeek(ms: number) {
  const d = new Date(startOfDay(ms));
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return d.getTime();
}

function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function at(dayMs: number, minutesOfDay: number) {
  const d = new Date(startOfDay(dayMs));
  d.setMinutes(minutesOfDay);
  return d.toISOString();
}

function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function minsFromStart(iso: string) {
  const d = new Date(iso);
  return Math.max(0, d.getHours() * 60 + d.getMinutes() - DAY_START * 60);
}

function durationMin(e: CalEvent) {
  if (!e.end_at) return 60;
  return Math.max(15, (Date.parse(e.end_at) - Date.parse(e.start_at)) / 60_000);
}

function tint(e: CalEvent, courseOf: (t: string) => Course | null, vars: Record<Course, string>) {
  const c = courseOf(e.title);
  return c ? vars[c] : 'var(--ink-3)';
}

function syncClass(e: CalEvent) {
  return e.sync_state === 'pending' ? 'pending' : e.sync_state === 'failed' ? 'failed' : '';
}

function syncTitle(e: CalEvent) {
  if (e.sync_state === 'pending') return 'Saved here. Waiting for the laptop to put it in Google and Outlook.';
  if (e.sync_state === 'failed') return e.sync_error ?? 'The calendars did not take this change.';
  const seen = e.seen_in?.length ? e.seen_in.join(' and ') : 'unknown';
  return `In ${seen}`;
}

/**
 * Side-by-side lanes for overlapping events.
 *
 * Without this, a 9:30 class and a 9:30 coffee sit exactly on top of each
 * other and one is invisible — which is the single thing a day view exists to
 * prevent.
 */
function layout(list: CalEvent[]): { ev: CalEvent; lane: number; lanes: number }[] {
  const out: { ev: CalEvent; lane: number; lanes: number }[] = [];
  let cluster: CalEvent[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (!cluster.length) return;
    const laneEnds: number[] = [];
    const placed = cluster.map((ev) => {
      const s = Date.parse(ev.start_at);
      let lane = laneEnds.findIndex((end) => end <= s);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = s + durationMin(ev) * 60_000;
      return { ev, lane };
    });
    for (const p of placed) out.push({ ...p, lanes: laneEnds.length });
    cluster = [];
    clusterEnd = -1;
  };

  for (const ev of list) {
    const s = Date.parse(ev.start_at);
    if (cluster.length && s >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, s + durationMin(ev) * 60_000);
  }
  flush();
  return out;
}

function nowLine(nowMs: number) {
  const d = new Date(nowMs);
  const mins = d.getHours() * 60 + d.getMinutes() - DAY_START * 60;
  if (mins < 0 || mins > (DAY_END - DAY_START) * 60) return null;
  return <div className="nowline" style={{ top: (mins / 60) * PX_PER_HOUR }} aria-hidden />;
}

function rangeLabel(view: CalView, anchor: number, days: number[]) {
  if (view === 'day') {
    return new Date(anchor).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  if (view === 'month') {
    return new Date(anchor).toLocaleDateString([], { month: 'long', year: 'numeric' });
  }
  const a = new Date(days[0]), b = new Date(days[days.length - 1]);
  const sameMonth = a.getMonth() === b.getMonth();
  return sameMonth
    ? `${a.getDate()}–${b.getDate()} ${a.toLocaleDateString([], { month: 'long' })}`
    : `${a.toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${b.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}
