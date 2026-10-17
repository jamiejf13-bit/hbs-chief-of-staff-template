// Free-time gaps in today's calendar, used only by the suggestion line (spec §4).

import type { CalEvent } from './types';

export interface Gap {
  startMs: number;
  minutes: number;
  label: string;
}

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 22;
const MIN_USEFUL_GAP = 20;

/**
 * Returns today's free blocks between DAY_START_HOUR and DAY_END_HOUR,
 * ignoring anything shorter than MIN_USEFUL_GAP. Overlapping events are
 * merged first — Outlook and Google both carry the same class, so a naive
 * pass would report a gap that does not exist.
 */
export function todaysGaps(events: CalEvent[], nowMs: number): Gap[] {
  const dayStart = new Date(nowMs);
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
  const dayEnd = new Date(nowMs);
  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

  const from = Math.max(dayStart.getTime(), nowMs);
  const to = dayEnd.getTime();
  if (from >= to) return [];

  const busy = events
    .map((e) => ({
      s: Date.parse(e.start_at),
      e: e.end_at ? Date.parse(e.end_at) : Date.parse(e.start_at) + 3600_000,
    }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > from && b.s < to)
    .sort((a, b) => a.s - b.s);

  const merged: { s: number; e: number }[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else merged.push({ ...b });
  }

  const gaps: Gap[] = [];
  let cursor = from;
  for (const b of merged) {
    if (b.s > cursor) push(cursor, Math.min(b.s, to));
    cursor = Math.max(cursor, b.e);
    if (cursor >= to) break;
  }
  if (cursor < to) push(cursor, to);

  return gaps;

  function push(s: number, e: number) {
    const minutes = Math.floor((e - s) / 60_000);
    if (minutes >= MIN_USEFUL_GAP) {
      gaps.push({ startMs: s, minutes, label: labelFor(s, nowMs) });
    }
  }
}

function labelFor(startMs: number, nowMs: number): string {
  if (startMs - nowMs < 5 * 60_000) return 'right now';
  const d = new Date(startMs);
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `at ${hour12}${m ? ':' + String(m).padStart(2, '0') : ''}${suffix}`;
}

/** The first gap worth suggesting into, or null. */
export function nextGap(events: CalEvent[], nowMs: number): Gap | null {
  return todaysGaps(events, nowMs)[0] ?? null;
}
