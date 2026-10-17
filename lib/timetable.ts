import { COURSE_RE } from './profile';

/**
 * Timetabled classes are recognised by the same rule the UI colours them by:
 * a title containing one of the course codes listed in lib/profile.json.
 *
 * Kept conservative on purpose: a false positive only blocks an edit and says
 * why, while a false negative would let a class be mirrored to the wrong time.
 *
 * Shared rather than copied. The drag-to-move route and the agent's
 * `move_event` tool both refuse classes, and two copies of this regex would
 * eventually disagree about what a class is — at which point one route would
 * let through the change the other was written to prevent.
 */
export function isTimetabled(title: string): boolean {
  return COURSE_RE.test(title);
}
