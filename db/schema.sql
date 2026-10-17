-- The console — schema (spec §3)
-- Apply with:  npm run db:push   (or: psql "$DATABASE_URL" -f db/schema.sql)
-- Safe to re-run.
--
-- Course codes are free text: the valid set is `courses` in lib/profile.json,
-- which SQL cannot read, so the app checks them instead. The participation and
-- lead-day defaults below use the standard HBS RC courses (MKT, STRAT, FRC,
-- TOM, LEAD, FIN1); the worker adds rows for any other course it sees.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tasks

create table if not exists tasks (
  id            uuid primary key default gen_random_uuid(),
  title         text        not null,
  notes         text,

  -- origin drives every sync decision. mirrored rows belong to a source
  -- system and are overwritten; owned rows are the user's and never touched.
  origin        text        not null check (origin in ('mirrored','owned')),
  source        text        not null check (source in ('canvas','12twenty','email','manual')),
  source_id     text,

  category      text        not null check (category in ('class','recruiting','admin','personal')),
  course        text,

  due_at        timestamptz,
  work_opens_at timestamptz,
  est_minutes   integer     check (est_minutes is null or est_minutes > 0),

  done          boolean     not null default false,
  done_at       timestamptz,

  -- soft delete: a mirrored task that vanishes from its source is retired,
  -- never hard-deleted, so a flaky sync cannot destroy history.
  deleted_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Where the work actually lives. Without these, a task says "read the FRC case"
-- and you still have to go and find it — which defeats the point.
--   url   the Canvas assignment page
--   links [{href, label, kind}] pulled out of the assignment description:
--         'case'           hbsp.harvard.edu coursepack link — needs your HBP
--                          browser session to resolve to a PDF
--         'canvas-file'    carries a verifier token, downloadable with the API
--                          token alone
--         'harvard-online' learn.harvardonline.harvard.edu
--         'other'          anything else, kept rather than discarded
alter table tasks add column if not exists url text;
alter table tasks add column if not exists links jsonb not null default '[]'::jsonb;

-- the dedupe key for sync. partial so manual tasks (source_id null) don't collide.
create unique index if not exists tasks_source_key
  on tasks (source, source_id) where source_id is not null;

create index if not exists tasks_open_idx
  on tasks (done, deleted_at, due_at);

-- an owned task must not carry a source_id; a mirrored one must.
alter table tasks drop constraint if exists tasks_origin_source_id;
alter table tasks add constraint tasks_origin_source_id check (
  (origin = 'owned'    and source_id is null) or
  (origin = 'mirrored' and source_id is not null)
);

-- ---------------------------------------------------------------- events

create table if not exists events (
  id               uuid primary key default gen_random_uuid(),
  title            text        not null,
  start_at         timestamptz not null,
  end_at           timestamptz,
  location         text,

  source           text        not null check (source in ('gcal','12twenty','email','outlook')),
  source_id        text,
  url              text,

  registered       boolean     not null default false,
  matched_filters  text[]      not null default '{}',
  conferencing_url text,

  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists events_source_key
  on events (source, source_id) where source_id is not null;

create index if not exists events_window_idx on events (start_at);

-- Calendar reconciliation (spec §1a). Outlook and Google share no identifiers,
-- so the same commitment is recognised by a match_key: normalised title plus
-- start time rounded to 15 minutes. seen_in records which sources last
-- reported it, and divergence is computed only from sources whose sync is ok.
alter table events add column if not exists match_key text;
alter table events add column if not exists seen_in text[] not null default '{}';

-- Set on an Outlook event once it has been copied into Google, so a mirror
-- that runs twice before the next reconcile cannot create a duplicate.
alter table events add column if not exists mirrored_at timestamptz;
alter table events add column if not exists mirror_gcal_id text;

create index if not exists events_match_idx on events (match_key);

-- ---------------------------------------------------------------- actions

create table if not exists actions (
  id          uuid primary key default gen_random_uuid(),
  type        text        not null check (type in (
                'register_event','send_email','create_calendar_event',
                'attach_conferencing_link','update_event_time')),
  status      text        not null default 'pending' check (status in (
                'pending','approved','skipped','executing','done','failed','expired')),

  summary     text        not null,   -- one line, read on a phone
  detail      text        not null default '',
  preview     text,                   -- FULL draft text for send_email
  payload     jsonb       not null default '{}'::jsonb,

  confidence  real        not null default 1.0 check (confidence >= 0 and confidence <= 1),
  expires_at  timestamptz not null,

  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  error       text
);

-- Reconciliation adds two action types (spec §1a). Re-stated rather than
-- edited in place so this file stays safe to re-run on an existing database.
alter table actions drop constraint if exists actions_type_check;

create index if not exists actions_pending_idx
  on actions (status, expires_at) where status in ('pending','approved');

-- ---------------------------------------------------------------- sources

create table if not exists sources (
  name         text primary key check (name in ('canvas','gcal','gmail','outlook','12twenty')),
  status       text not null default 'stale' check (status in ('ok','stale','error')),
  last_sync_at timestamptz,
  last_error   text
);

insert into sources (name) values ('canvas'),('gcal'),('gmail'),('outlook'),('12twenty')
  on conflict (name) do nothing;

-- ---------------------------------------------------------------- worker heartbeat

create table if not exists worker_heartbeat (
  id        boolean primary key default true check (id),
  beat_at   timestamptz not null default now(),
  note      text
);

insert into worker_heartbeat (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------- participation
-- Mirrored from the Class Log tab of the master tracker. The tracker stays
-- authoritative for coursework; this is a read-only projection of it.

create table if not exists participation (
  course               text primary key,
  sessions_since_spoke integer     not null default 0 check (sessions_since_spoke >= 0),
  last_spoke_at        timestamptz,
  goal_every           integer     not null default 3 check (goal_every > 0),
  updated_at           timestamptz not null default now()
);

insert into participation (course) values
  ('MKT'),('STRAT'),('FRC'),('TOM'),('LEAD'),('FIN1')
  on conflict (course) do nothing;

-- ---------------------------------------------------------------- agent runs
-- Tier 1 work is silent, not invisible. The worker appends one row per pass
-- so the dashboard can show what happened without asking for approval.

create table if not exists agent_runs (
  id          uuid primary key default gen_random_uuid(),
  finished_at timestamptz not null default now(),
  next_run_at timestamptz,
  did         text[]      not null default '{}'
);

create index if not exists agent_runs_recent_idx on agent_runs (finished_at desc);

-- ---------------------------------------------------------------- weights

create table if not exists weights (
  id              boolean primary key default true check (id),
  category_weight jsonb not null default
    '{"class":1.2,"recruiting":1.4,"admin":1.0,"personal":0.8}'::jsonb,
  lead_days       jsonb not null default
    '{"MKT":1,"STRAT":1,"FRC":2,"TOM":1,"LEAD":1,"FIN1":2,"recruiting":3,"admin":1}'::jsonb,
  updated_at      timestamptz not null default now()
);

insert into weights (id) values (true) on conflict (id) do nothing;

-- every automatic adjustment writes a line the user can read and revert (spec §4)
create table if not exists weight_changes (
  id         uuid primary key default gen_random_uuid(),
  field      text        not null,
  key        text        not null,
  old_value  real        not null,
  new_value  real        not null,
  reason     text        not null,
  reverted   boolean     not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- rank_events

create table if not exists rank_events (
  id                uuid primary key default gen_random_uuid(),
  shown_at          timestamptz not null default now(),
  ranked_first_id   uuid references tasks(id) on delete set null,
  acted_on_id       uuid references tasks(id) on delete set null,
  position_of_acted integer not null,
  context           jsonb not null default '{}'::jsonb
);

create index if not exists rank_events_recent_idx on rank_events (shown_at desc);

-- ---------------------------------------------------------------- updated_at

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks
  for each row execute function touch_updated_at();

drop trigger if exists events_touch on events;
create trigger events_touch before update on events
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Preferences that must follow the student between the laptop and the phone.
-- Singleton, like weights. Browser storage would not do: a decision made on
-- the laptop on Sunday has to still hold on the phone on Monday.
-- ---------------------------------------------------------------------------
create table if not exists prefs (
  id boolean primary key default true check (id),
  -- The class day whose prep the student chose not to be offered early. Cleared
  -- implicitly by moving on: once the next class day differs, the offer
  -- returns. That makes "not this weekend" mean this weekend, not forever.
  get_ahead_dismissed_for date,
  updated_at timestamptz not null default now()
);
insert into prefs (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Tasks the student creates and orders by hand.
-- ---------------------------------------------------------------------------

-- 'social' is not a flavour of 'personal'. A section coffee chat and a dentist
-- appointment are different commitments and the score should weigh them
-- differently, so it gets its own category rather than bending an existing one.
alter table tasks drop constraint if exists tasks_category_check;
alter table tasks add constraint tasks_category_check
  check (category in ('class','recruiting','admin','personal','social'));

-- The student's explicit priority, independent of the computed score. 1 high,
-- 2 normal, 3 low. Null means not stated, which is not the same as "normal" — the
-- ranking treats an unset priority as "use the formula".
alter table tasks add column if not exists priority smallint
  check (priority is null or priority between 1 and 3);

-- Manual ordering. Sparse by design: reordering rewrites one row, not the list.
alter table tasks add column if not exists sort_order double precision;

insert into weights (id) values (true) on conflict (id) do nothing;
update weights
   set category_weight = category_weight || '{"social": 0.6}'::jsonb
 where id = true and not (category_weight ? 'social');

-- Clubs are their own commitment: section- and club-level obligations that are
-- neither recruiting nor purely social, and that the student chooses to take on.
alter table tasks drop constraint if exists tasks_category_check;
alter table tasks add constraint tasks_category_check
  check (category in ('class','recruiting','social','clubs','admin','personal'));

update weights
   set category_weight = category_weight || '{"clubs": 0.7}'::jsonb
 where id = true and not (category_weight ? 'clubs');

-- ---------------------------------------------------------------------------
-- Events the student creates or edits from the console.
-- ---------------------------------------------------------------------------

-- Same rule as tasks: 'owned' rows are the student's and sync never overwrites them.
alter table events add column if not exists origin text not null default 'mirrored'
  check (origin in ('mirrored','owned'));

-- Neither Google nor Outlook can be written from Vercel: both sets of
-- credentials are local-only by design. So an edit lands here first and the
-- laptop applies it. 'pending' is an honest state, not a failure — but it has
-- to be visible, or you would believe your calendar had changed when it had not.
alter table events add column if not exists sync_state text not null default 'synced'
  check (sync_state in ('synced','pending','failed'));
alter table events add column if not exists sync_error text;

-- Which to-do this block is set aside for, if any. Deleting the task should
-- not delete the time that was blocked, so this nulls rather than cascades.
alter table events add column if not exists task_id uuid references tasks(id) on delete set null;

create index if not exists events_pending_idx on events (sync_state) where sync_state = 'pending';

-- A note left when resolving a reconciliation card: why the answer was yes,
-- or what the event actually is. It travels with the action, and where the
-- action creates a calendar entry it is written into that entry's body — so
-- the reason survives in the place you will next look, not only in a log.
alter table actions add column if not exists note text;

-- Google returns an all-day event as `start.date` (a calendar day) rather than
-- `start.dateTime` (an instant). Storing it as midnight UTC put every birthday
-- on the evening of the day before in Eastern time, and sending a dateTime
-- back to Google for one is rejected outright. So the distinction is kept.
alter table events add column if not exists all_day boolean not null default false;

-- ---------------------------------------------------------------------------
-- What Gmail found. Read-only: nothing here is ever sent, archived or labelled.
--
-- Three kinds, because the rail asks three different questions:
--   'priority'      mail that looks like it wants a reply
--   'linkedin_role' a job from a LinkedIn alert email (never scraped — spec)
--   'contact'       a person worth reaching out to, from CPD or LinkedIn
-- ---------------------------------------------------------------------------
create table if not exists email_items (
  id           uuid primary key default gen_random_uuid(),
  kind         text        not null check (kind in ('priority','linkedin_role','contact')),
  gmail_id     text        not null,
  thread_id    text,

  subject      text        not null,
  from_name    text,
  from_email   text,
  snippet      text,
  url          text,

  -- Why it scored as it did, as plain strings. Shown on hover: the ranking has
  -- to be arguable, and "trust me" is not arguable (spec §5).
  reasons      text[]      not null default '{}',
  score        integer     not null default 0,

  received_at  timestamptz not null,
  -- The student has dealt with it. Set from the console, never by the worker.
  handled      boolean     not null default false,
  handled_at   timestamptz,

  -- A drafted outreach note for a 'contact'. Draft only — never sent.
  draft        text,

  created_at   timestamptz not null default now(),
  unique (kind, gmail_id)
);

create index if not exists email_items_open_idx
  on email_items (kind, score desc, received_at desc) where not handled;

-- 'news' joins the three: industry reading the student already subscribes to,
-- pulled out of the newsletters in their own inbox rather than fetched from anywhere.
alter table email_items drop constraint if exists email_items_kind_check;
alter table email_items add constraint email_items_kind_check
  check (kind in ('priority','linkedin_role','contact','news'));

-- ---------------------------------------------------------------------------
-- Job postings, from wherever they come.
--
-- LinkedIn arrives via alert emails (email_items), 12Twenty and company job
-- boards arrive here. The rail shows them as one list, because "where did this
-- posting come from" is not a question anyone is asking.
-- ---------------------------------------------------------------------------
create table if not exists job_postings (
  id          uuid primary key default gen_random_uuid(),
  source      text        not null,          -- greenhouse | ashby | 12twenty | ...
  source_id   text        not null,
  company     text        not null,
  title       text        not null,
  location    text,
  url         text        not null,
  posted_at   timestamptz,

  reasons     text[]      not null default '{}',
  score       integer     not null default 0,

  first_seen  timestamptz not null default now(),
  dismissed   boolean     not null default false,
  unique (source, source_id)
);

create index if not exists job_postings_open_idx
  on job_postings (score desc, first_seen desc) where not dismissed;

-- 'jobs' is the company job boards. The name check has to allow it first.
-- Dropped, not re-stated. Three copies of this list existed, each frozen at
-- the moment it was written, and the OLDEST ran first: it rejected
-- 'outlook-mail', a source live for days, and the migration stopped there. One
-- canonical list now lives further down; adding a row here only needs the old
-- constraint out of the way.
alter table sources drop constraint if exists sources_name_check;
insert into sources (name) values ('jobs') on conflict (name) do nothing;

-- The student has dealt with a recruiting prompt: registered, or decided it is
-- not for them. The event stays on the calendar because it is real; it just stops
-- being offered. Sync must never reset this — it is the student's decision, not
-- the source's.
alter table events add column if not exists recruiting_dismissed boolean not null default false;

-- When the reading panel was last rebuilt. Mail is read every 20 minutes for
-- the priority list; the news set is refreshed twice a day, because a panel
-- that reshuffles every twenty minutes is not something you can finish reading.
alter table prefs add column if not exists news_refreshed_at timestamptz;

-- A one-line summary of a news item, taken from the newsletter itself. Not
-- generated: Gmail's own snippet is the publisher's standfirst, which is a
-- better TLDR than anything inferred from a subject line.
alter table email_items add column if not exists tldr text;

-- One event the student has said is the same commitment as another. Set from the
-- chat box when the automatic rules miss a pair; the row stays so a re-sync
-- cannot resurrect it, and the surviving event is named so it can be undone.
alter table events add column if not exists duplicate_of uuid references events(id) on delete set null;

-- Participation, from the Class Log tab of the master tracker.
-- "Spoke twice in nine" is the question actually asked; sessions_since_spoke
-- alone could not answer it.
alter table participation add column if not exists spoke_count integer not null default 0;
alter table participation add column if not exists total_sessions integer not null default 0;
alter table participation add column if not exists last_type text;

alter table sources drop constraint if exists sources_name_check;
insert into sources (name) values ('tracker') on conflict (name) do nothing;


-- What the worker is, not just that it beat.
--
-- Twice now something looked broken on the page when the truth was that the
-- worker had died, or was running code written after it started. Neither was
-- visible anywhere, so both cost an hour of looking in the wrong place.
alter table worker_heartbeat add column if not exists started_at timestamptz;
alter table worker_heartbeat add column if not exists code_stale boolean not null default false;
alter table worker_heartbeat add column if not exists last_error text;


-- How many sessions were actually logged, kept apart from how many the course
-- has held. "Spoke in 1 of 1" can be true of the log and false of the term: a
-- course may have held four classes with only one of them written down.
alter table participation add column if not exists logged_sessions integer not null default 0;

-- The Canvas prompt in full, and what the student plans to say about it.
--
-- `notes` is a 500-character flattened summary built for a one-line preview;
-- it loses the numbering and the line breaks, which is most of what an HBS
-- assignment question is. `prompt` keeps the description as written.
--
-- `response` is the student's. Canvas sync writes `prompt` on every pass and must
-- never touch `response` — overwriting a prepared answer would be the single
-- worst thing this sync could do.
alter table tasks add column if not exists prompt text;
alter table tasks add column if not exists response text;
alter table tasks add column if not exists response_at timestamptz;

-- What Outlook still needs doing to it by hand.
--
-- Google is the master: the console writes there through a real API, and HBS
-- blocks every route to writing Outlook (Graph Explorer itself is refused for
-- student accounts — AADSTS50105, app assignment required). So a change made here
-- lands in Google and leaves Outlook behind, and the only honest thing to do
-- is say so on the event rather than let the two quietly disagree.
--
-- Set on the GOOGLE row, because that is the row that stays visible; the
-- stale Outlook twin is hidden behind it via duplicate_of until Outlook is
-- caught up by hand, at which point both are cleared automatically.
alter table events add column if not exists outlook_needs text;

-- The two halves of the worker, tracked apart.
--
-- Canvas, Gmail, Google Calendar and the job boards are plain API calls and
-- run in the cloud on a schedule. Outlook and 12Twenty need the student's
-- signed-in browser and the Class Log is a file on the laptop, so those stay
-- there — as does anything that acts on the student's behalf.
--
-- Separate columns, not a shared heartbeat: a cloud run must never make a
-- dead laptop look alive. That is the whole point of showing the health at
-- all, and one beat for two processes would quietly destroy it.
alter table worker_heartbeat add column if not exists cloud_beat_at timestamptz;
alter table worker_heartbeat add column if not exists cloud_note text;

-- Which mailbox an item came from.
--
-- Mail is often read in Gmail and answered in Outlook, so a Gmail-only view
-- showed one half of every conversation and called it the whole thing — a
-- thread already dealt with still sat in "Priority email" looking unanswered.
--
-- `gmail_id` keeps its name and becomes "the id that mailbox gave it": the
-- column predates there being a second mailbox, and renaming it across the
-- worker, the API and the page to gain nothing but tidiness is not worth the
-- chance of missing one.
alter table email_items add column if not exists source text not null default 'gmail';
alter table email_items drop constraint if exists email_items_kind_gmail_id_key;
create unique index if not exists email_items_source_key
  on email_items (kind, source, gmail_id);

-- Outlook mail is a source in its own right, separate from the Outlook
-- calendar: the calendar can be read every five minutes and the mailbox does
-- not need to be, and when one breaks the other usually has not.
--
-- Added here because markSource() catches its own errors, so a name missing
-- from this list does not fail loudly — it just never appears in Sources, and
-- a source whose health is invisible is the one that dies unnoticed.
-- The canonical list. Every source name lives here and nowhere else, so a new
-- one is added in one place rather than leaving an older copy to reject it.
alter table sources drop constraint if exists sources_name_check;
insert into sources (name) values ('writeups') on conflict (name) do nothing;

-- Which Outlook folder a message was found in.
--
-- Many students file aggressively: a recruiting folder with subfolders, a
-- folder per course, one per club. If a rule moves most mail out of the Inbox
-- before it is ever seen there, reading only the Inbox misses the recruiting
-- mail entirely — which was the whole reason for reading Outlook at all.
--
-- Kept because it is the best signal in the mailbox about what a message IS.
-- The student sorted it; that judgement is better than anything a scorer infers
-- from a subject line.
alter table email_items add column if not exists folder text;

-- Whether the Outlook copy of a registered 12Twenty event has been made.
--
-- Separate from mirror_gcal_id because the two calendars are written by
-- completely different means: Google through its API, Outlook by driving a
-- compose form in a browser. Either can succeed while the other fails, and a
-- single flag would lose that.
--
-- Outlook gives nothing back to identify what it created, so this records
-- only that it was done — which is enough to stop it being done twice, and is
-- all the browser path can honestly claim.
alter table events add column if not exists outlook_mirrored_at timestamptz;

-- Read state, and "not relevant" as distinct from "handled".
--
-- `unread` was being used to score and then thrown away, so nothing could
-- answer "which of these has already been opened?" — which is half of what
-- decides whether an item still needs attention.
--
-- `not_relevant` is deliberately NOT the same as `handled`. Handled means it was
-- dealt with; not_relevant means this kind of thing should stop appearing.
-- Only the second is worth learning from, and collapsing them into one flag
-- would teach the wrong lesson from every email that was simply finished.
alter table email_items add column if not exists unread boolean;
alter table email_items add column if not exists not_relevant boolean not null default false;
alter table email_items add column if not exists not_relevant_at timestamptz;


-- `refresh_mail` used to be added here by dropping the type constraint and not
-- putting it back, which left `actions` unconstrained and made the canonical
-- ADD further up fail on the next run: a real row the check did not allow.
-- The type now lives in that canonical list instead, so nothing is needed here.

-- The prep write-up a daily case-prep task produces, carried onto the class task.
--
-- Those documents live in a local folder as .docx, one per case, named by the
-- class date — `2026-10-02 Example Case - Prep.docx`. Nothing
-- connected that folder to this database, so asking the agent to "pull the
-- write-ups for tomorrow's classes" got an honest "I only manage tasks and
-- calendar": the files existed, written that afternoon, and were invisible here.
--
-- Stored on the task rather than in a table of their own, for the same reason
-- `prompt` is: `lib/state.ts` does `select * from tasks`, so a column arrives
-- in the UI with no query, route or type plumbing in between. A write-up does
-- belong to a case rather than to a task, and if two tasks ever share one this
-- will need normalising — today the course and the class date identify it.
--
-- Written by the sync on every pass, like `prompt`, and like `prompt` it must
-- never touch `response`.
alter table tasks add column if not exists writeup text;
alter table tasks add column if not exists writeup_path text;
alter table tasks add column if not exists writeup_at timestamptz;

-- The write-up as something you can open, not only as text on the task.
--
-- The .docx lives on the laptop, and a file:/// link is blocked from an https
-- page and meaningless on a phone. The worker uploads it to Drive as a Google
-- Doc; this is where that link lives.
--
-- `writeup_drive_id` exists so a rewritten document is REPLACED rather than
-- uploaded again. Without it, every edit the daily prep task makes would leave
-- another copy in Drive and change the link out from under anything already
-- opened.
alter table tasks add column if not exists writeup_url text;
alter table tasks add column if not exists writeup_drive_id text;

-- How long a task takes, and where that number came from.
--
-- Almost no open tasks carry an estimate: Canvas does not supply duration, so
-- nothing fills it, and that empty column is what blocks reconciling the work
-- against free time. A calendar panel built on this column while it was empty
-- would report the student as free.
--
-- `est_source` exists so a guess is never mistaken for a decision. A number the
-- student typed and a number a model produced are both integers in the same
-- column and would otherwise be indistinguishable on screen. The estimator fills
-- nulls only; a human estimate is never overwritten.
--
-- The value 'owner' means "entered by you". It is matched in lib/types.ts, so
-- rename it in both places or not at all.
alter table tasks add column if not exists est_source text
  check (est_source is null or est_source in ('model', 'owner'));
alter table tasks add column if not exists est_why text;

-- Anything already carrying a number got it from the seed or from the owner.
update tasks set est_source = 'owner' where est_minutes is not null and est_source is null;

alter table sources drop constraint if exists sources_name_check;
insert into sources (name) values ('estimates') on conflict (name) do nothing;

-- People from 12Twenty's networking directory.
--
-- /mentorships/search, not /students, and the difference is the point: everyone
-- listed there opted in to being contacted. A cold message to the general
-- directory is an intrusion; one to a mentorship member is what they signed up
-- for.
--
-- Scored by whether they already do the work the student wants — function
-- first, industry second, city only as a tie-break. Excluded employers come
-- from lib/targets.json, the same list the LinkedIn search panel reads, so the
-- two cannot drift.
create table if not exists people (
  id          uuid primary key default gen_random_uuid(),
  source      text not null check (source in ('12twenty')),
  -- Name plus employer. 12Twenty exposes no stable id on the card, and a
  -- person who changes job is genuinely a new row worth surfacing again.
  source_id   text not null,

  name        text not null,
  employer    text,
  title       text,
  location    text,
  program     text,
  grad_year   integer,

  score       integer not null default 0,
  reasons     text[]  not null default '{}',
  url         text,

  -- The student's. A sync must never clear these: the point of marking someone handled
  -- is that they stay handled.
  contacted_at  timestamptz,
  dismissed     boolean not null default false,
  dismissed_at  timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists people_source_idx on people (source, source_id);
create index if not exists people_rank_idx on people (score desc) where not dismissed;

alter table sources drop constraint if exists sources_name_check;
insert into sources (name) values ('people') on conflict (name) do nothing;

-- The ONE source-name constraint, deliberately the last statement in this file
-- that touches it.
--
-- Three migrations have failed because a new name was added by appending
-- another copy of this list: the older copy still ran first and rejected a row
-- that was already live ('refresh_mail', then 'outlook-mail', then
-- 'estimates'). Earlier blocks now only DROP the constraint so their inserts
-- can run; this is the only place that states what is allowed.
--
-- Adding a source means adding its name HERE, and nowhere else.
alter table sources drop constraint if exists sources_name_check;
alter table sources add constraint sources_name_check
  check (name in ('12twenty', 'alumni', 'canvas', 'estimates', 'gcal', 'gmail', 'jobs', 'outlook', 'outlook-mail', 'people', 'tracker', 'writeups'));
insert into sources (name) values ('alumni') on conflict (name) do nothing;

-- What the student decided about each person, and what that teaches.
--
-- An early run surfaced roles in industries outside the target list. The
-- immediate cause was a matching bug, but the real one is structural: inferring
-- an industry from a company NAME does not work. Some names state their
-- industry outright and others say nothing at all, even when the company is
-- squarely on target. No keyword list fixes that, because the information is
-- not in the name.
--
-- The student can tell, instantly, in a way no rule can. So the rules stop
-- guessing and start learning: three decisions per person, and the words of the
-- employers rejected become a penalty on the next ones that look the same.
alter table people add column if not exists status text not null default 'new'
  check (status in ('new', 'not_interested', 'to_contact', 'contacted'));
alter table people add column if not exists status_at timestamptz;

-- Carry the old boolean across so nothing already dismissed comes back.
update people set status = 'not_interested' where dismissed and status = 'new';

create index if not exists people_status_idx on people (status, score desc);

-- people_signals was a table holding one row per learned token. It is gone:
-- people.status already records every decision, so the signal is derived from
-- those rows on each scoring pass and cannot disagree with what was clicked.
-- Keeping both meant the API route had to write the second copy, which pulled
-- worker code into Next's bundle and failed on every click.
drop table if exists people_signals;

-- Alumni found by searching the directory for target companies, as opposed to
-- the mentorship directory people who opted in. Same table, different
-- provenance, and the distinction matters: a mentorship member opted in to
-- being contacted and a directory entry did not, so the UI should be able to
-- say which is which.
alter table people drop constraint if exists people_source_check;
alter table people add constraint people_source_check
  check (source in ('12twenty', '12twenty-alumni'));

-- A source that is working but will not be for long.
--
-- 12Twenty's sign-in lasts about thirty-six hours — Harvard's CAS expires the
-- ticket long before the thirty-day cookie carrying it. Nothing can be done
-- about the duration ("keep me signed in" does not help), but the timing was
-- making it worse than it needed to be: the first sign was an error
-- notification, which arrived whenever it arrived, usually when the student was
-- away from the laptop and could do nothing about it.
--
-- `warning` lets a source say "still fine, but deal with me" while it is still
-- green, so the prompt can arrive while you are sitting in front of the machine
-- that can answer it. Distinct from `last_error`, which means something is
-- already broken, and cleared on every successful pass like it is.
alter table sources add column if not exists warning text;

-- When the student last actually signed in to 12Twenty, written by the login script.
-- The cookie's own expiry says thirty days and is not to be believed; this is
-- the only honest clock for how long the session has left.
alter table prefs add column if not exists twelvetwenty_signed_in_at timestamptz;

-- A button that opens the 12Twenty sign-in window on the laptop.
--
-- Harvard expires the SSO ticket after about a day and a half and no amount of
-- code changes a university's session policy. What it changes is the cost:
-- until now it meant finding a terminal and typing a path, every other day,
-- and the notification usually arrived on the phone, where that is impossible.
-- The action runs on the laptop, so the button only does anything when you are
-- at the machine that can answer it — which is the right place for it to work
-- and the right place for it to be useless.
--
-- It cannot sign you in. The Harvard password is yours to type.
alter table actions drop constraint if exists actions_type_check;

-- The ONE action-type constraint, deliberately the last statement in this file
-- that touches it.
--
-- Adding a type by appending another copy of this list has broken the
-- migration twice: the older copy runs first and rejects a row that is already
-- live. sources_name_check was consolidated for exactly this reason and stopped
-- recurring; this one had not been, so it recurred here with
-- 'twelvetwenty_login'.
--
-- Adding an action type means adding its name HERE, and nowhere else.
alter table actions drop constraint if exists actions_type_check;
alter table actions add constraint actions_type_check check (type in (
  'attach_conferencing_link',
  'create_calendar_event',
  'google_auth',
  'mirror_to_outlook',
  'refresh_mail',
  'register_event',
  'remove_stale_event',
  'resolve_event_conflict',
  'send_email',
  'twelvetwenty_login',
  'update_event_time'));

-- While a 12Twenty sign-in window is open, the readers stay off the profile.
--
-- A Chromium profile carries one live instance. The sign-in button spawned its
-- window straight into the worker's own 12Twenty pass and lost the race every
-- time: the action reported success and nothing appeared. Ten minutes covers
-- the login script's eight-minute wait, and a sync skipped for ten minutes
-- costs nothing against a sign-in that cannot happen at all.
alter table prefs add column if not exists twelvetwenty_busy_until timestamptz;

-- Applied, and no longer listed.
--
-- `applied` is a judgement the student makes, and it goes in the database
-- rather than in localStorage like the /internships tracker once did. "Where
-- have I applied" is the student's data — but localStorage does not reach the
-- phone, and a console that disagrees with itself between devices is not to be
-- trusted. The student's database, the student's row.
--
-- `last_seen_at` and `expired_at` exist because nothing knew whether a posting
-- was still open. The sweep upserted whatever it found and never noticed what
-- had gone, so a closed role sat at the top of the list scoring 9 for ever.
-- A posting is expired when a board that ANSWERED this pass no longer lists
-- it — a board that timed out must never expire its own postings, which is the
-- obvious way to get this wrong.
alter table job_postings add column if not exists applied boolean not null default false;
alter table job_postings add column if not exists applied_at timestamptz;
alter table job_postings add column if not exists last_seen_at timestamptz;
alter table job_postings add column if not exists expired_at timestamptz;

-- Anything already stored was last seen when it was first stored; without this
-- every existing row looks unseen and would expire on the next sweep.
update job_postings set last_seen_at = coalesce(last_seen_at, first_seen);

create index if not exists job_postings_open_idx
  on job_postings (expired_at nulls first, score desc) where not dismissed and not applied;

-- The internships tracker, moved off a static file and out of localStorage.
--
-- It was data/internships.json baked in at build time, with status, dates and
-- notes in browser storage. That made it the one part of the console that
-- could not talk to anything: a role the job boards found could never reach
-- it, a deadline typed in months ago could not be corrected by live board
-- data, and phone and laptop disagreed about where you had applied. The
-- tracker has to be tied to the same data as everything else.
--
-- The privacy reasoning in the old page was sound and is overridden
-- deliberately: the database is the student's own, already holds their
-- calendar and mailbox, and the cross-device problem is real.
--
-- Two kinds of fact live here and are kept apart. Columns without a prefix
-- describe the ROLE and may be refreshed from a job board. Columns prefixed
-- `my_` are the STUDENT'S and no sync may ever write them.
create table if not exists tracked_roles (
  id            uuid primary key default gen_random_uuid(),

  -- 'watchlist' came from the curated file, 'board' was added from a live
  -- posting, 'manual' typed in by hand.
  origin        text not null default 'watchlist'
                check (origin in ('watchlist', 'board', 'manual')),
  -- The watchlist's own id, or a job_postings id. Lets a re-import update
  -- rather than duplicate, and lets a board posting keep its link home.
  source_ref    text,

  company       text not null,
  role          text not null,
  function      text,
  locations     text,
  nyc_option    text,
  -- The role's availability, not your progress: Open, Not yet posted, Closed.
  availability  text,
  deadline      date,
  timing        text,
  pay           text,
  blurb         text,
  link          text,
  link_check    text,
  keywords_key  text,
  priority      text,

  -- The student's.
  my_status     text,
  applied_on    date,
  my_notes      text,
  starred       boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists tracked_roles_source_idx
  on tracked_roles (origin, source_ref) where source_ref is not null;
create index if not exists tracked_roles_order_idx
  on tracked_roles (starred desc, priority);

-- Who the student has spoken to at a company.
--
-- Kept against the COMPANY rather than a role, because that is how it works:
-- a conversation with someone at Example Co. is worth knowing about on every
-- Example Co. role being tracked — "who have I spoken to at the company", not
-- at the posting.
create table if not exists role_contacts (
  id         uuid primary key default gen_random_uuid(),
  company    text not null,
  name       text not null,
  title      text,
  -- Coffee chat, email, event, referral — free text, not a fixed list.
  how        text,
  spoke_on   date,
  notes      text,
  created_at timestamptz not null default now()
);
create index if not exists role_contacts_company_idx on role_contacts (lower(company));
