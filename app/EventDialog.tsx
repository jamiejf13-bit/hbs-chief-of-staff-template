'use client';

import { useEffect, useRef, useState } from 'react';
import type { CalEvent, Task } from '@/lib/types';

/**
 * Create or edit one calendar event.
 *
 * Replaces a window.prompt that could only take a title. Times and location
 * are the fields that actually get changed, and a prompt could not carry them.
 *
 * Deliberately not a full editor: recurrence, attendees and reminders are
 * absent because this console cannot write them to Outlook, and offering a
 * field that silently does nothing is worse than not offering it.
 */

export type DraftEvent = {
  id?: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string;
  task_id: string | null;
};

type Props = {
  draft: DraftEvent;
  /** Present when editing something that already exists. */
  existing: CalEvent | null;
  tasks: Task[];
  busy: boolean;
  error: string | null;
  onSave: (d: DraftEvent) => void;
  onDelete: (() => void) | null;
  onClose: () => void;
};

export default function EventDialog({
  draft, existing, tasks, busy, error, onSave, onDelete, onClose,
}: Props) {
  const [title, setTitle] = useState(draft.title);
  const [date, setDate] = useState(toDate(draft.start_at));
  const [start, setStart] = useState(toTime(draft.start_at));
  const [end, setEnd] = useState(toTime(draft.end_at));
  const [location, setLocation] = useState(draft.location);
  const [taskId, setTaskId] = useState<string>(draft.task_id ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => { firstField.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Shown before saving, because "ends before it starts" is easy to do with
  // two time fields and confusing to hit as a server error.
  const backwards = end <= start;

  return (
    <div className="modalwrap" role="dialog" aria-modal="true" aria-label={existing ? 'Edit event' : 'New event'}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (backwards || !title.trim()) return;
          onSave({
            id: draft.id,
            title: title.trim(),
            start_at: iso(date, start),
            end_at: iso(date, end),
            location: location.trim(),
            task_id: taskId || null,
          });
        }}
      >
        <h2>{existing ? 'Edit event' : 'New event'}</h2>

        <label>
          <span>What</span>
          <input ref={firstField} value={title} maxLength={500} required
                 onChange={(e) => setTitle(e.target.value)} placeholder="Coffee with Pat" />
        </label>

        <div className="row3">
          <label>
            <span>Date</span>
            <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            <span>From</span>
            <input type="time" value={start} required step={300} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            <span>To</span>
            <input type="time" value={end} required step={300} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        {backwards && <p className="mwarn">The end time has to be after the start time.</p>}

        <label>
          <span>Where</span>
          <input value={location} maxLength={300}
                 onChange={(e) => setLocation(e.target.value)} placeholder="Room — optional" />
        </label>

        <label>
          <span>Time set aside for</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">Nothing in particular</option>
            {tasks.filter((t) => !t.done).slice(0, 60).map((t) => (
              <option key={t.id} value={t.id}>
                {t.course ? `${t.course} · ` : ''}{t.title.slice(0, 70)}
              </option>
            ))}
          </select>
        </label>

        {existing && existing.sync_state !== 'synced' && (
          <p className="mnote">
            {existing.sync_state === 'pending'
              ? 'Waiting for the laptop to put this in Google and Outlook.'
              : existing.sync_error}
          </p>
        )}

        {error && <p className="mwarn" role="alert">{error}</p>}

        <div className="mbtns">
          <button type="submit" className="btn-ok" disabled={busy || backwards || !title.trim()}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Add'}
          </button>
          <button type="button" className="btn-no" onClick={onClose} disabled={busy}>Cancel</button>

          {onDelete && (
            <button
              type="button"
              className={confirmDelete ? 'btn-del armed' : 'btn-del'}
              disabled={busy}
              // Two taps, because deleting reaches a real calendar and there
              // is no undo once the laptop has applied it.
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            >
              {confirmDelete ? 'Really delete' : 'Delete'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/* Local-time helpers. The input fields are local; the API wants ISO. */

function two(n: number) { return String(n).padStart(2, '0'); }

function toDate(isoStr: string) {
  const d = new Date(isoStr);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function toTime(isoStr: string) {
  const d = new Date(isoStr);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function iso(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}
