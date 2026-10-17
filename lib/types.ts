// Shared types. These mirror db/schema.sql — change both together.

export type Category =
  | 'class' | 'recruiting' | 'social' | 'clubs' | 'admin' | 'personal';
/**
 * A course code, e.g. 'MKT'. Deliberately a plain string: the valid codes are
 * whatever lib/profile.json lists under `courses`, so an RC Spring or EC
 * student can use their own courses without touching this file. Server code
 * validates against COURSE_CODES from lib/profile.ts.
 */
export type Course = string;

export const CATEGORIES: Category[] =
  ['class', 'recruiting', 'social', 'clubs', 'admin', 'personal'];
/**
 * The default RC Fall course list, for client components that cannot import
 * lib/profile.ts (it would ship the profile in a public bundle). Server-side
 * validation does not use this; it reads COURSE_CODES from lib/profile.json.
 */
export const COURSES: Course[] = ['MKT', 'STRAT', 'FRC', 'TOM', 'LEAD', 'FIN1'];

export interface Task {
  id: string;
  title: string;
  notes: string | null;

  /**
   * The most important field in the schema.
   * `mirrored` — a source system owns it. Sync overwrites title/due by source_id.
   *              Ticking it off is local; nothing is ever submitted back.
   * `owned`    — the user created it. Sync never touches it.
   */
  origin: 'mirrored' | 'owned';
  source: 'canvas' | '12twenty' | 'email' | 'manual';
  source_id: string | null;

  category: Category;
  course: Course | null;

  due_at: string | null;
  work_opens_at: string | null;
  est_minutes: number | null;
  /**
   * Where est_minutes came from. 'owner' (you typed it) is a decision, 'model' is a guess, and null
   * means nothing has estimated it yet.
   *
   * Shown on screen, because a number the owner typed and a number a model produced
   * are otherwise the same integer in the same column — and the calendar maths
   * that will read this should not quietly launder a guess into a commitment.
   */
  est_source: 'model' | 'owner' | null;
  /** The model's one-line reason, so the owner can see what it thought drove it. */
  est_why: string | null;

  /**
   * The owner's explicit priority: 1 high, 2 normal, 3 low.
   * Null is not "normal" — it means they have not said, and the computed score
   * decides. Conflating the two would make every untouched task look
   * deliberately ranked.
   */
  priority: 1 | 2 | 3 | null;
  /** Manual position. Null means "wherever the ranking puts it". */
  sort_order: number | null;

  done: boolean;
  done_at: string | null;
  created_at: string;
  updated_at: string;

  /**
   * The assignment description in full, line breaks and numbering intact.
   * This is where the HBS preparation questions live. `notes` is the same
   * text flattened to 500 characters for the list row and is no substitute.
   */
  prompt: string | null;
  /** What the owner plans to say about it. Theirs; never written by a sync. */
  response: string | null;
  response_at: string | null;

  /**
   * The prep write-up a daily prep task wrote for this class, in full.
   *
   * A .docx in a local documents folder, read and flattened to text by the
   * worker. Distinct from `prompt`, which is the question Canvas asked;
   * this is the owner's own prepared answer to it.
   */
  writeup: string | null;
  /** Where that document lives on disk, for the worker's own change detection. */
  writeup_path: string | null;
  /** The document's own last-modified time, not when it was read. */
  writeup_at: string | null;
  /**
   * The same write-up as a Google Doc, which is the one that can actually be
   * opened: a file:/// path is blocked from an https page and absent on a phone.
   */
  writeup_url: string | null;
  /** The Drive file, so a rewrite replaces it instead of making a second copy. */
  writeup_drive_id: string | null;

  /** The Canvas assignment page, when the task came from Canvas. */
  url: string | null;
  /** Materials pulled out of the assignment description, cases first. */
  links: TaskLink[];
}

export interface TaskLink {
  href: string;
  label: string;
  /**
   * 'case'           — hbsp.harvard.edu coursepack link. Resolves to the case
   *                    PDF only through the owner's signed-in HBP browser session.
   * 'canvas-file'    — carries a verifier token; downloadable with the API token.
   * 'harvard-online' — learn.harvardonline.harvard.edu content.
   */
  kind: 'case' | 'canvas-file' | 'harvard-online' | 'other';
}

export interface CalEvent {
  id: string;
  title: string;
  start_at: string;
  end_at: string | null;
  location: string | null;
  source: 'gcal' | '12twenty' | 'email' | 'outlook';
  source_id: string | null;
  url: string | null;
  registered: boolean;
  matched_filters: string[];
  conferencing_url: string | null;
  /** Normalised title + 15-minute start bucket. How the same commitment is
   *  recognised across Outlook and Google, which share no identifiers. */
  match_key: string | null;
  /** Which sources last reported this event, e.g. ['outlook','gcal'].
   *  A single entry means the calendars have diverged — see spec §1a. */
  seen_in: string[];

  /** 'owned' events were created here and sync never overwrites them. */
  origin: 'mirrored' | 'owned';
  /**
   * Whether the real calendars have caught up.
   * 'pending' means the change exists here and the laptop has not applied it
   * yet — an honest state, and one the UI must show rather than imply the
   * calendars already agree.
   */
  sync_state: 'synced' | 'pending' | 'failed';
  sync_error: string | null;
  /**
   * What Outlook still needs doing to it by hand, or null when the two agree.
   *
   * Google is the master — the console writes there through a real API, and
   * HBS blocks every route to writing Outlook. So a change made here lands in
   * Google and leaves Outlook behind, and this is the instruction for closing
   * the gap. Cleared automatically by the next Outlook read that comes back
   * agreeing.
   */
  outlook_needs: string | null;
  /** The owner has dealt with this recruiting prompt — registered, or not for them. */
  recruiting_dismissed: boolean;
  /** The to-do this block was set aside for, if any. */
  task_id: string | null;
  /**
   * A calendar day rather than an instant — birthdays, holidays, travel days.
   * These have no position on a time grid and cannot be dragged; Google
   * refuses a time on one.
   */
  all_day: boolean;
}

export type ActionType =
  | 'register_event'
  | 'send_email'
  | 'create_calendar_event'
  | 'attach_conferencing_link'
  | 'update_event_time'
  /** Google-only event the owner confirms is real — copy it into Outlook. */
  | 'mirror_to_outlook'
  /** Google-only event the owner confirms was cancelled — remove it from Google. */
  | 'remove_stale_event'
  /** Same event in both calendars, details disagree — the owner picks a version. */
  | 'resolve_event_conflict';

export type ActionStatus =
  | 'pending' | 'approved' | 'skipped'
  | 'executing' | 'done' | 'failed' | 'expired';

export interface AgentAction {
  id: string;
  type: ActionType;
  status: ActionStatus;
  summary: string;
  detail: string;
  preview: string | null;
  payload: Record<string, unknown>;
  confidence: number;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
  error: string | null;
}

export interface SourceHealth {
  name:
    | 'canvas' | 'gcal' | 'gmail' | 'outlook' | 'outlook-mail' | '12twenty'
    | 'jobs' | 'tracker' | 'writeups' | 'estimates' | 'people' | 'alumni';
  status: 'ok' | 'stale' | 'error';
  last_sync_at: string | null;
  last_error: string | null;
  /**
   * Working, but not for much longer — said while it can still be acted on.
   *
   * The 12Twenty sign-in lasts about thirty-six hours, and the first sign of
   * expiry used to be an error notification arriving wherever the owner
   * happened to be, usually on a phone, where signing in is impossible. A
   * warning appears while the source is still green and while the owner is at
   * the laptop that can fix it.
   */
  warning: string | null;
}

export interface Weights {
  category_weight: Record<Category, number>;
  lead_days: Record<string, number>;
  updated_at: string;
}

/**
 * Participation per course, read from the Class Log tab of the master tracker.
 * Not in the written spec — added from the prototype, which is right that this
 * is the most useful thing on the page at 10:48am.
 */
export interface Participation {
  course: Course;
  /** 0 = spoke in the most recent session. */
  sessions_since_spoke: number;
  last_spoke_at: string | null;
  /** The standing goal: contribute at least every N sessions. */
  goal_every: number;
  /** Sessions spoken in, and sessions logged. "2 of 3", not a percentage. */
  spoke_count: number;
  /** Sessions the course has held — from Canvas class numbering where known. */
  total_sessions: number;
  /** Sessions actually written down. Lower than total when the log is behind. */
  logged_sessions: number;
  /** How the owner contributed last time — Analysis/numbers, Reframed the question. */
  last_type: string | null;
}

export type ColdCallRisk = 'low' | 'medium' | 'high';

/** What the agent did on its last pass. Tier 1 work is silent, not invisible. */
export interface AgentRun {
  id: string;
  finished_at: string;
  next_run_at: string | null;
  did: string[];
}

/**
 * Something Gmail found. Read-only — nothing is ever sent, archived or
 * labelled, and `draft` is a suggestion the owner may copy, never an outbox.
 */
export interface EmailItem {
  id: string;
  /**
   * Which mailbox it came from.
   *
   * Mail is read in Gmail and answered in Outlook, so showing only one was
   * showing half of every conversation. Displayed on the row, because "why
   * have I not seen this?" has a different answer for each.
   */
  source: 'gmail' | 'outlook';
  /**
   * The Outlook folder it was filed in, when it came from there.
   *
   * The owner's own filing, which is the best signal in the mailbox about what a
   * message is — better than anything inferred from a subject line.
   */
  folder: string | null;
  kind: 'priority' | 'linkedin_role' | 'contact' | 'news';
  subject: string;
  from_name: string | null;
  from_email: string | null;
  snippet: string | null;
  url: string | null;
  /** Why it ranked where it did, in plain words. The scoring must be arguable. */
  reasons: string[];
  score: number;
  received_at: string;
  handled: boolean;
  draft: string | null;
  /** One line from the publisher, for the reading panel. */
  tldr: string | null;
}

/** A role from a company job board. LinkedIn roles live in EmailItem. */
export interface JobPosting {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string | null;
  url: string;
  posted_at: string | null;
  reasons: string[];
  score: number;
  first_seen: string;
  /** The owner has applied. Recorded here rather than in localStorage so the
   *  phone and the laptop agree, which they did not for the internships tracker. */
  applied: boolean;
  /**
   * When a board that ANSWERED a sweep stopped listing this role.
   *
   * Null means open. A board that failed to respond never sets this — expiring
   * on absence alone would close every role at a company whose API blinked.
   */
  expired_at: string | null;
}

/**
 * Someone from 12Twenty's networking directory worth reaching out to.
 *
 * From /mentorships/search, not the general student directory: everyone here
 * opted in to being contacted, which is what makes an approach reasonable
 * rather than an intrusion.
 */
export interface Person {
  id: string;
  source: '12twenty';
  name: string;
  employer: string | null;
  title: string | null;
  location: string | null;
  program: string | null;
  grad_year: number | null;
  /** Function first, industry second, city only as a tie-break. */
  score: number;
  reasons: string[];
  url: string | null;
  /** The owner's. A sync never writes this. */
  contacted_at: string | null;
}

export interface Prefs {
  /**
   * The class day (YYYY-MM-DD) whose prep the owner has declined to start early.
   * Null means the offer stands. Not a permanent setting — once the next
   * class day moves on, the offer comes back on its own.
   */
  get_ahead_dismissed_for: string | null;
}

export interface ConsoleState {
  now: string;
  prefs: Prefs;
  tasks: Task[];
  events: CalEvent[];
  actions: AgentAction[];
  sources: SourceHealth[];
  participation: Participation[];
  emails: EmailItem[];
  jobs: JobPosting[];
  /** Opted-in contacts from 12Twenty's mentorship directory. */
  people: Person[];
  last_run: AgentRun | null;
  weights: Weights;
  /** null when the worker has never checked in. */
  worker_last_beat: string | null;
  /** true when the API has not heard from the worker in over an hour (spec §8). */
  worker_offline: boolean;
  /** When the current worker process started, if it has reported one. */
  worker_started_at: string | null;
  /**
   * The worker is running code older than the files on disk. Node caches
   * modules at import, so an edit does nothing until it restarts.
   */
  worker_code_stale: boolean;
  /**
   * The cloud half — Canvas, Gmail, Google Calendar, the job boards.
   *
   * Tracked apart from the laptop on purpose. One beat for two processes
   * would make a laptop that died at midnight look alive all night, because
   * something somewhere was still running, and knowing which half is down is
   * the entire value of showing this at all.
   */
  cloud_last_beat: string | null;
  cloud_offline: boolean;
  /** true when the state is seed data because no database is configured. */
  seeded: boolean;
}
