import { CATEGORIES, type Category, type Course } from './types';
import { COURSE_CODES } from './profile';

type Fields = {
  category: Category | null;
  course: Course | null;
  due_at: string | null;
  priority: number | null;
  est_minutes: number | null;
};

/**
 * Validate the editable fields. Shared by create and update so the two cannot
 * drift apart and accept different things.
 */
export function readFields(body: Record<string, unknown>): { value: Fields } | { error: string } {
  const category = body.category == null ? null : String(body.category);
  if (category !== null && !CATEGORIES.includes(category as Category)) {
    return { error: `Unknown category "${category}".` };
  }

  const course = body.course == null || body.course === '' ? null : String(body.course);
  // Valid codes come from lib/profile.json, so each student's own courses work.
  if (course !== null && !COURSE_CODES.includes(course)) {
    return { error: `Unknown course "${course}".` };
  }

  let due_at: string | null = null;
  if (body.due_at != null && body.due_at !== '') {
    const t = Date.parse(String(body.due_at));
    if (Number.isNaN(t)) return { error: 'That deadline is not a date.' };
    due_at = new Date(t).toISOString();
  }

  let priority: number | null = null;
  if (body.priority != null && body.priority !== '') {
    priority = Number(body.priority);
    if (![1, 2, 3].includes(priority)) return { error: 'Priority is 1, 2 or 3.' };
  }

  let est_minutes: number | null = null;
  if (body.est_minutes != null && body.est_minutes !== '') {
    est_minutes = Number(body.est_minutes);
    if (!Number.isFinite(est_minutes) || est_minutes <= 0) {
      return { error: 'Estimated minutes must be a positive number.' };
    }
    est_minutes = Math.round(est_minutes);
  }

  return { value: { category: category as Category | null, course: course as Course | null, due_at, priority, est_minutes } };
}
