/**
 * Validation shared by event create and event update.
 *
 * Kept out of the route files so the two cannot drift apart and start
 * accepting different things — the bug that would let a phone create an event
 * the laptop then refuses to mirror.
 */

export type EventFields = {
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  task_id: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readEventFields(
  body: Record<string, unknown>,
): { value: EventFields } | { error: string } {
  let title: string | null = null;
  if (body.title != null) {
    title = String(body.title).trim();
    if (!title) return { error: 'An event needs a title.' };
    if (title.length > 500) return { error: 'That title is too long.' };
  }

  const when = (k: 'start_at' | 'end_at'): string | null | undefined => {
    if (body[k] == null || body[k] === '') return body[k] === undefined ? undefined : null;
    const t = Date.parse(String(body[k]));
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  };

  const start_at = 'start_at' in body ? when('start_at') : null;
  if (start_at === undefined) return { error: 'That start time is not a date.' };
  const end_at = 'end_at' in body ? when('end_at') : null;
  if (end_at === undefined) return { error: 'That end time is not a date.' };

  // An event that ends before it starts is almost always a drag gone wrong,
  // and it renders as a negative-height block rather than an error.
  if (start_at && end_at && Date.parse(end_at) <= Date.parse(start_at)) {
    return { error: 'The end time has to be after the start time.' };
  }

  let location: string | null = null;
  if (body.location != null) {
    location = String(body.location).trim().slice(0, 300) || null;
  }

  let task_id: string | null = null;
  if (body.task_id != null && body.task_id !== '') {
    task_id = String(body.task_id);
    if (!UUID.test(task_id)) return { error: 'That task reference is not valid.' };
  }

  return { value: { title, start_at, end_at, location, task_id } };
}
