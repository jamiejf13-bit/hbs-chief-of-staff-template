// Seed state shown before DATABASE_URL is set: real shapes, clearly fake
// content, dates computed relative to now so Today always has something in it.
//
// This is scaffolding. Once the database exists, the worker push replaces it.
// Every person, company and event below is invented.

import { PROFILE } from './profile';
import type {
  ConsoleState, Task, CalEvent, AgentAction, Weights, Participation, AgentRun,
} from './types';

function at(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const nowIso = () => new Date().toISOString();

function task(p: Partial<Task> & Pick<Task, 'id' | 'title' | 'origin' | 'source' | 'category'>): Task {
  return {
    notes: null,
    prompt: null,
    response: null,
    response_at: null,
    source_id: p.origin === 'mirrored' ? (p.source_id ?? `seed/${p.id}`) : null,
    course: null,
    due_at: null,
    work_opens_at: null,
    est_minutes: null,
    done: false,
    done_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    url: null,
    links: [],
    ...p,
  } as Task;
}

export const SEED_WEIGHTS: Weights = {
  category_weight: {
    class: 1.2, recruiting: 1.4, social: 0.6, clubs: 0.7, admin: 1.0, personal: 0.8,
  },
  lead_days: {
    ...Object.fromEntries(PROFILE.courses.map((c) => [c.code, c.leadDays ?? 1])),
    recruiting: 3, admin: 1,
  },
  updated_at: nowIso(),
};

export function seedTasks(): Task[] {
  return [
    task({
      id: 'seed-frc-case',
      title: 'FRC case prep — read exhibits, run the T-accounts',
      origin: 'mirrored', source: 'canvas', source_id: '10001/assignments/seed-1',
      category: 'class', course: 'FRC',
      due_at: at(1, 9, 30), work_opens_at: at(-1, 8), est_minutes: 90,
      prompt:
        'Preparation Questions\n\n'
        + '1. How did the change in revenue recognition policy affect reported earnings?\n'
        + '2. Reconstruct the T-accounts for the deferred revenue balance.\n'
        + '3. Would you have signed off on the restatement? Why?',
    }),
    task({
      id: 'seed-strat-case',
      title: 'STRAT case prep — what would you have to believe',
      origin: 'mirrored', source: 'canvas', source_id: '10002/assignments/seed-2',
      category: 'class', course: 'STRAT',
      due_at: at(1, 11, 10), work_opens_at: at(0, 8), est_minutes: 75,
    }),
    task({
      id: 'seed-tom-pset',
      title: 'TOM problem set',
      origin: 'mirrored', source: 'canvas', source_id: '10003/assignments/seed-3',
      category: 'class', course: 'TOM',
      due_at: at(2, 13, 50), work_opens_at: at(0, 8), est_minutes: 60,
    }),
    task({
      id: 'seed-lead-reflection',
      title: 'LEAD reflection memo',
      origin: 'mirrored', source: 'canvas', source_id: '10004/assignments/seed-4',
      category: 'class', course: 'LEAD',
      due_at: at(4, 23, 59), work_opens_at: at(2, 8), est_minutes: 45,
    }),
    task({
      id: 'seed-speaker',
      title: 'Sign up — Pat Example (Example AI Co), Room 101',
      origin: 'mirrored', source: '12twenty', source_id: 'event/seed-speaker',
      category: 'recruiting',
      due_at: at(1, 17, 0), work_opens_at: at(-2, 8), est_minutes: 5,
    }),
    task({
      id: 'seed-coffee',
      title: 'Book a coffee chat with a second-year',
      origin: 'mirrored', source: 'email', source_id: 'thread/seed-coffee',
      category: 'recruiting',
      due_at: at(3, 17, 0), work_opens_at: at(0, 8), est_minutes: 15,
    }),
    task({
      id: 'seed-google-app',
      title: 'Submit Example Co PM internship application — essay not started',
      origin: 'owned', source: 'manual',
      category: 'recruiting',
      due_at: at(6, 23, 59), work_opens_at: at(-1, 8), est_minutes: 120,
    }),
    task({
      id: 'seed-alerts',
      title: 'Rebuild LinkedIn job alerts around MBA internship terms',
      origin: 'owned', source: 'manual',
      category: 'recruiting', est_minutes: 20, work_opens_at: at(0, 8),
    }),
    task({
      id: 'seed-cpd',
      title: 'Confirm the two CPD advisor appointments',
      origin: 'owned', source: 'manual',
      category: 'admin', due_at: at(0, 17, 0), work_opens_at: at(0, 8), est_minutes: 10,
    }),
    task({
      id: 'seed-errand',
      title: 'Renew renter insurance',
      origin: 'owned', source: 'manual',
      category: 'personal', due_at: at(2, 12, 0), work_opens_at: at(-1, 8), est_minutes: 20,
    }),
    task({
      id: 'seed-fin1',
      title: 'FIN1 problem set',
      origin: 'mirrored', source: 'canvas', source_id: '10005/assignments/seed-5',
      category: 'class', course: 'FIN1',
      // work window has not opened — must NOT appear in Today, only in Week
      due_at: at(7, 9, 30), work_opens_at: at(5, 8), est_minutes: 90,
    }),
  ];
}

export function seedEvents(): CalEvent[] {
  const base = (id: string, title: string, day: number, h: number, m: number, endH: number, endM: number, loc: string | null): CalEvent => ({
    id, title,
    start_at: at(day, h, m), end_at: at(day, endH, endM),
    location: loc,
    source: 'outlook', source_id: `outlook/${id}`, url: null,
    origin: 'mirrored', sync_state: 'synced', sync_error: null, outlook_needs: null, task_id: null, all_day: false,
    recruiting_dismissed: false,
    registered: false, matched_filters: [], conferencing_url: null,
    match_key: null, seen_in: ['outlook'],
  });

  return [
    base('ev-dg-0', 'Discussion Group', 0, 8, 30, 9, 10, null),
    base('ev-mkt-0', `MKT ${PROFILE.section}`, 0, 9, 30, 10, 50, 'Classroom'),
    base('ev-strat-0', `STRAT ${PROFILE.section}`, 0, 11, 10, 12, 30, 'Classroom'),
    base('ev-tom-0', `TOM ${PROFILE.section}`, 0, 13, 50, 15, 10, 'Classroom'),
    base('ev-dg-1', 'Discussion Group', 1, 8, 30, 9, 10, null),
    base('ev-frc-1', `FRC ${PROFILE.section}`, 1, 9, 30, 10, 50, 'Classroom'),
    base('ev-strat-1', `STRAT ${PROFILE.section}`, 1, 11, 10, 12, 30, 'Classroom'),
    {
      ...base('ev-speaker', 'Conversation with Pat Example (Example AI Co)', 1, 16, 0, 17, 0, 'Room 101'),
      source: '12twenty',
      source_id: '12twenty/seed-speaker',
      url: 'https://mba-business-harvard.12twenty.com',
      matched_filters: ['big tech', 'AI', 'senior operator'],
    },
    {
      ...base('ev-infosession', 'Example Payments Co — GTM Strategy info session', 4, 18, 0, 19, 30, 'Room 102'),
      source: '12twenty',
      source_id: '12twenty/seed-infosession',
      url: 'https://mba-business-harvard.12twenty.com',
      registered: true,
      matched_filters: ['growth-stage', 'GTM'],
    },
    {
      ...base('ev-trek', 'Tech Club — trek sign-ups open', 6, 9, 0, 9, 30, null),
      source: 'email',
      source_id: 'email/seed-trek',
      matched_filters: ['tech club'],
    },
  ];
}

export function seedActions(): AgentAction[] {
  return [
    {
      id: 'act-seed-1',
      type: 'register_event',
      status: 'pending',
      summary: 'Register for Pat Example (Example AI Co), Room 101',
      detail: 'Tomorrow 16:00–17:00. No calendar conflict. Matched: big tech, AI, senior operator.',
      preview: null,
      payload: { event_id: 'ev-speaker' },
      confidence: 0.92,
      expires_at: at(1, 15, 0),
      created_at: nowIso(),
      resolved_at: null,
      error: null,
    },
  ];
}

export function seedParticipation(): Participation[] {
  const p = (course: Participation['course'], since: number, daysAgo: number | null): Participation => ({
    course,
    sessions_since_spoke: since,
    last_spoke_at: daysAgo === null ? null : at(-daysAgo, 10, 0),
    goal_every: 3,
    spoke_count: Math.max(0, 4 - since),
    total_sessions: 4,
    logged_sessions: 4,
    last_type: null,
  });
  // One row per course in lib/profile.json, with made-up counts.
  return PROFILE.courses.map((c, i) => p(c.code, 1 + (i % 3), 2 + i * 2));
}

export function seedLastRun(): AgentRun {
  return {
    id: 'run-seed',
    finished_at: at(0, 6, 4),
    next_run_at: at(0, 13, 0),
    did: [
      'Filed 4 Canvas wrap slides into your course running notes',
      "Logged Friday's Class Log entries and updated the Takeaways Index",
      'Scanned 12Twenty: 11 new events, 2 match your filters',
      "Pulled tomorrow's FRC case PDF from the HBP coursepack link",
    ],
  };
}

export function seedState(): ConsoleState {
  return {
    now: nowIso(),
    prefs: { get_ahead_dismissed_for: null },
    emails: [],
    jobs: [],
    // Empty rather than invented. Seed data stands in for a database that does
    // not exist yet, and a fabricated person with a real-looking name and
    // employer is the one kind of placeholder that could actually be acted on.
    people: [],
    tasks: seedTasks(),
    events: seedEvents(),
    actions: seedActions(),
    sources: [
      { name: 'canvas', status: 'stale', last_sync_at: null, last_error: null, warning: null },
      { name: 'gcal', status: 'stale', last_sync_at: null, last_error: null, warning: null },
      { name: 'gmail', status: 'stale', last_sync_at: null, last_error: null, warning: null },
      { name: 'outlook', status: 'stale', last_sync_at: null, last_error: null, warning: null },
      { name: '12twenty', status: 'stale', last_sync_at: null, last_error: null, warning: null },
    ],
    participation: seedParticipation(),
    last_run: seedLastRun(),
    weights: SEED_WEIGHTS,
    worker_last_beat: null,
    worker_offline: true,
    worker_started_at: null,
    worker_code_stale: false,
    cloud_last_beat: null,
    cloud_offline: true,
    seeded: true,
  };
}
