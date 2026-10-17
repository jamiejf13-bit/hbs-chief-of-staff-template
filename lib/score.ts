// Prioritisation (spec §4).
//
// Deliberately a formula you can read, predict and correct — not a model.
// If the ranking ever feels wrong, the weights are editable and this file
// explains exactly what they do.
//
//   score = urgency × category_weight × blocking_bump

import type { Task, Weights } from './types';

/**
 * Urgency as a function of time remaining, steepening as the deadline nears.
 *
 *   overdue        → 10    (pins to the top)
 *   6 hours out    → 3.0
 *   1 day out      → 1.2
 *   3 days out     → 0.47
 *   no due date    → 0.6   (visible, but never top)
 *
 * A task whose work window has opened is multiplied by 1.5 — the spec's
 * "steep after work_opens_at". Before the window opens the task is hidden
 * from Today entirely, so that branch only affects Week ordering.
 */
export function urgency(task: Task, nowMs: number): number {
  if (!task.due_at) return 0.6;

  const hours = (Date.parse(task.due_at) - nowMs) / 3_600_000;
  if (!Number.isFinite(hours)) return 0.6;
  if (hours <= 0) return 10;

  const base = 36 / (hours + 6);
  const opened =
    task.work_opens_at !== null && Date.parse(task.work_opens_at) <= nowMs;

  return Math.min(10, opened ? base * 1.5 : base);
}

/**
 * 1.3 when another open task depends on this one finishing first.
 * Dependencies are not modelled yet — this returns 1.0 until they are,
 * rather than pretending to a signal we do not have.
 */
export function blockingBump(_task: Task, _all: Task[]): number {
  return 1.0;
}

export function score(task: Task, all: Task[], weights: Weights, nowMs: number): number {
  const cat = weights.category_weight[task.category] ?? 1.0;
  return urgency(task, nowMs) * cat * blockingBump(task, all);
}

/** Actionable today: work window open (or absent), not done. Spec §5. */
export function isActionableToday(task: Task, nowMs: number): boolean {
  if (task.done) return false;
  if (!task.work_opens_at) return true;
  return Date.parse(task.work_opens_at) <= nowMs;
}

/**
 * Ranking, with the owner's own judgement on top of the formula.
 *
 * Three tiers, in order:
 *   1. Anything dragged into a position (`sort_order`) sits exactly
 *      where it was put, above everything else. An explicit choice outranks
 *      a computed one — otherwise reordering is a suggestion, not a control.
 *   2. Then the priority flag, high before normal before low.
 *   3. Then the formula, unchanged.
 *
 * An unset priority is deliberately *not* treated as normal. It means the
 * owner has not expressed a view, so the formula decides — which is why untouched tasks
 * still sort by urgency among themselves rather than all landing in a
 * middle band.
 */
export function rankForToday(tasks: Task[], weights: Weights, nowMs: number): Task[] {
  /**
   * Everything not done — including work whose window has not opened.
   *
   * The original rule dropped a task until its work window opened, one or two
   * days before the class. On a Sunday that hid every one of Tuesday's
   * assignments, while Tuesday's marketing case was being read at the time.
   * A list that omits the thing currently being worked on is wrong regardless of
   * what the rule says.
   *
   * The window still matters and is still shown — a not-yet-open task carries
   * an "opens Monday" marker and sorts under its own due day — but it governs
   * emphasis now, not existence. `isActionableToday` is unchanged and still
   * gates the suggestion line, which is about what to start *right now*.
   */
  const actionable = tasks.filter((t) => !t.done);

  const pinned = actionable
    .filter((t) => t.sort_order != null)
    .sort((a, b) => (a.sort_order! - b.sort_order!) || collate(a, b));

  const rest = actionable
    .filter((t) => t.sort_order == null)
    .map((t) => ({ t, s: score(t, tasks, weights, nowMs) }))
    .sort((a, b) => {
      const ap = a.t.priority, bp = b.t.priority;
      if (ap !== bp) {
        if (ap != null && bp != null) return ap - bp;      // 1 before 3
        if (ap === 1) return -1;                            // high beats unset
        if (bp === 1) return 1;
        if (ap === 3) return 1;                             // low loses to unset
        if (bp === 3) return -1;
      }
      return b.s - a.s || collate(a.t, b.t);
    })
    .map((x) => x.t);

  return [...pinned, ...rest];
}

/** Stable tiebreak so equal scores don't shuffle between renders. */
function collate(a: Task, b: Task): number {
  const ad = a.due_at ? Date.parse(a.due_at) : Number.MAX_SAFE_INTEGER;
  const bd = b.due_at ? Date.parse(b.due_at) : Number.MAX_SAFE_INTEGER;
  return ad - bd || a.id.localeCompare(b.id);
}

/**
 * The suggestion line (spec §4). Advisory only — it never reorders the list.
 *
 * It speaks ONLY when it contradicts the ranking: the top task will not fit
 * the next gap but something further down will. Any other case — a gap big
 * enough for the top task, no gap, no estimates — it stays silent, because
 * repeating what the queue already says in minutes is noise.
 *
 * Revised after the original was seen live: on an empty evening
 * it announced "184 minutes right now" and then named the task already
 * sitting at the top of the list.
 */
export function suggestion(
  ranked: Task[],
  freeMinutes: number | null,
  gapLabel: string | null,
): string | null {
  if (freeMinutes === null || gapLabel === null || ranked.length === 0) return null;

  const top = ranked[0];
  if (top.est_minutes === null || top.est_minutes <= freeMinutes) return null;

  const fits = ranked.find(
    (t) => t.id !== top.id && t.est_minutes !== null && t.est_minutes <= freeMinutes,
  );
  if (!fits) return null;

  return `Only ${freeMinutes} minutes ${gapLabel} — not enough for ${top.title}. ${fits.title} fits.`;
}
