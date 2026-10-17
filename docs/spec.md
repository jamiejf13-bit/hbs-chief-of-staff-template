# Chief of Staff console — specification

A personal operating dashboard for an HBS RC student: one hosted page, reachable from phone and laptop, that shows classwork, recruiting, and calendar in a single view, and runs an agent that acts on routine work and queues the rest for one-tap approval.

Single user. Each student runs their own copy: no multi-tenancy, no accounts, no sharing. Everything personal (name, emails, courses, time zone) lives in `lib/profile.json`; the recruiting filter lives in `lib/targets.json`.

---

## 1. The constraint that shapes the architecture

The data sources are not equally reachable, and the design has to respect that rather than pretend otherwise.

| Source | Access | Where it runs |
|---|---|---|
| Canvas (`hbs.instructure.com`) | Real REST API, personal access token | Cloud or local |
| Google Calendar | OAuth API | Cloud or local |
| Gmail | OAuth API | Cloud or local |
| HBS Outlook (your `@mba20XX.hbs.edu` mailbox) | Browser session | **Local only** |
| 12Twenty (`mba-business-harvard.12twenty.com`) | No student API — browser session with existing login | **Local only** |
| LinkedIn | Closed API. Partner-gated, open endpoints return only own data. Scraping breaches the User Agreement and risks account restriction. | **Via email alerts only — never scrape** |

### 1a. The two calendars must converge, not compete

Most students use **both** calendars: school life lands in Outlook, and personal things get added to Google and are easily forgotten in the other. **The goal is that the two are aligned so either can be used interchangeably.** Neither is the master.

So the worker's job is **reconciliation**, not precedence. Never silently delete from one because the other lacks it — an absence is ambiguous, and guessing wrong either loses a real commitment or resurrects a cancelled one.

**Matching.** The two systems share no identifiers, so events are matched on a `match_key`: normalised title plus start time rounded to the nearest 15 minutes. One database row per match_key, carrying `seen_in` — which sources it was found in on the last successful read of each.

**The four cases:**

| State | Reading | Handling |
|---|---|---|
| In both, agreeing | Aligned | Nothing. |
| In both, details differ | One was edited | **Tier 2.** Show both versions, one tap to pick. |
| In Outlook only | Normally new — school events arrive here | **Tier 1.** Mirror into Google, since Google has a write API. Logged in the agent run, not queued. |
| In Google only | **Genuinely ambiguous.** Either you added it in Google and forgot, or it was cancelled in Outlook. | **Tier 2 — always confirm.** Never resolve this alone. |

The Google-only card offers exactly two outcomes: **"Still on — add it to Outlook"** (`mirror_to_outlook`) or **"Cancelled — remove from Google"** (`remove_stale_event`). Writing to Outlook is browser-driven and therefore only runs while the laptop is awake and signed in; the action waits in the queue until then.

**An absence only counts when the read succeeded.** A failed or skipped Outlook sync must never make events look deleted. Divergence is computed solely from sources whose last sync is `ok`.

*Design note: an earlier version of this section made Outlook authoritative and treated Google-only events as cancelled — which would have deleted anything entered only in Google. Do not reintroduce precedence.*

Therefore: **hybrid architecture.** The laptop is the worker; the cloud is the surface.

```
  LAPTOP (worker)                CLOUD (Vercel)              PHONE / LAPTOP
  ───────────────                ──────────────              ──────────────
  Canvas API          ─┐
  Google Cal API       │
  Gmail API            ├─ push ─► Next.js API ─► Postgres ─►  Dashboard UI
  Outlook (browser)    │            ▲                              │
  12Twenty (browser)  ─┘            └────── approved actions ──────┘
                         ◄─ poll ──
```

The worker pushes state up and polls for approved actions to execute. The UI never talks to a source system directly.

**Accepted consequence:** if the laptop is closed for days, 12Twenty and Outlook data goes stale. The UI must display per-source last-sync time and a worker heartbeat so stale data announces itself rather than silently misleading.

---

## 2. Stack

- **App:** Next.js (App Router), TypeScript, deployed on Vercel (`your-app.vercel.app`)
- **DB:** Postgres (Neon or Vercel Postgres)
- **Auth:** single shared password (`APP_PASSWORD`), httpOnly session cookie (`SESSION_SECRET`), middleware-gated. No OAuth for the user, no user table. The worker authenticates with a separate bearer token (`WORKER_TOKEN`).
- **Worker:** Node process on the laptop. Playwright for browser-session sources. Starts at logon, survives sleep/wake.
- **Styling:** plain CSS or Tailwind. Mobile-first — the phone is the primary surface.

---

## 3. Data model

The full schema is `db/schema.sql` (apply with `npm run db:push`). The core shapes:

### `tasks`

```ts
{
  id: string
  title: string
  notes: string | null

  origin: 'mirrored' | 'owned'     // see below — drives everything
  source: 'canvas' | '12twenty' | 'email' | 'manual'
  source_id: string | null          // dedupe key, e.g. "<courseId>/assignments/<assignmentId>"

  category: 'class' | 'recruiting' | 'social' | 'clubs' | 'admin' | 'personal'
  course: one of your course codes from lib/profile.json | null

  due_at: timestamptz | null
  work_opens_at: timestamptz | null // when it should start appearing
  est_minutes: number | null

  done: boolean
  done_at: timestamptz | null
  created_at: timestamptz
  updated_at: timestamptz
}
```

**`origin` is the most important field in the schema.**

- `mirrored` — owned by a source system. Sync updates it by `source_id`. If it vanishes from the source, soft-delete it. You may check it off (local only — never submit anything back to Canvas) but title/due edits will be overwritten on next sync, so the UI must disable those fields.
- `owned` — created manually. Sync never touches it. Persists until deleted.

### `events`

```ts
{
  id, title, start_at, end_at, location
  source: 'gcal' | '12twenty' | 'email' | 'outlook'
  source_id, url
  registered: boolean
  matched_filters: string[]       // why the 12Twenty scan flagged it
  conferencing_url: string | null // populated by the Zoom-link enricher
}
```

### `actions` — the only two-way collection

```ts
{
  id: string
  type: 'register_event' | 'send_email' | 'create_calendar_event'
      | 'attach_conferencing_link' | 'update_event_time' | ...   // full list in schema.sql
  status: 'pending' | 'approved' | 'skipped' | 'executing' | 'done' | 'failed' | 'expired'
  summary: string                 // one line, shown on phone
  detail: string                  // context: conflicts, seats, sender
  preview: string | null          // FULL draft text for send_email
  payload: jsonb                  // what the worker needs to execute
  confidence: number              // 0–1
  expires_at: timestamptz
  created_at, resolved_at, error: string | null
}
```

### `sources`

```ts
{ name, status: 'ok'|'stale'|'error', last_sync_at, last_error, warning }
```

### `weights` — the prioritization state, one row, user-editable

```ts
{
  category_weight: { class: number, recruiting: number, social: number, clubs: number, admin: number, personal: number }
  lead_days: { [courseCode]: number, recruiting: number, admin: number }
  updated_at
}
```

### `rank_events` — the learning signal

```ts
{ id, shown_at, ranked_first_id, acted_on_id, position_of_acted, context: jsonb }
```

---

## 4. Prioritization

### Scoring

Transparent formula. **Not an LLM, not a black box.** You must be able to read it, predict it, and correct it.

```
score = urgency × category_weight × blocking_bump

urgency        = f(hours until due_at), steep after work_opens_at
category_weight= from weights table; recruiting > class by default
blocking_bump  = 1.3 if another task depends on it, else 1.0
```

Tasks with `work_opens_at` in the future are hidden from Today entirely. They appear in Week.

The UI exposes a settings page showing the current weights as editable numbers. If the ranking ever feels wrong, you should be able to see why and change it directly.

### Learning

**Do not train on which task gets completed.** That is explained almost entirely by the due date and teaches nothing.

**The only informative signal is the mismatch.** Log a `rank_events` row whenever you act on something that was not ranked first, plus the position of what you chose. Two patterns to extract:

1. **Lead time.** If case prep for a course is consistently started N days before due, move `lead_days[course]` toward N. This is the highest-value adaptation — most students work ahead by one to three days, and it varies by course.
2. **Category preference.** If recruiting tasks are consistently chosen over higher-ranked class tasks (or vice versa), nudge `category_weight`.

Rules:
- Adjust only after a pattern repeats **at least 4 times**.
- Cap any single adjustment at **10%** of the current value.
- Every adjustment writes a visible line to a changelog (`weight_changes`) you can read and revert.
- Dragging a task to a different day in Week view is an explicit, high-weight lead-time signal — stronger than an inferred one.

### The suggestion line

Separate from scoring. A single sentence above the list, regenerated on load:

> "You have 90 minutes free at 2pm — that fits the TOM problem set, not the application essay."

Generated from open calendar gaps, `est_minutes`, and the current top of the queue. It is advisory only. **It must never reorder the list.** If it is wrong, you have lost one sentence.

**The line appears only when it contradicts the ranking** — the top task will not fit the next gap, but something further down will. Every other case is silent.

A version that spoke on every load would, on an open evening, announce "You have 184 minutes right now" and then name the task already at the top of the queue. Restating the ranking in minutes is noise. The line earns its place only in the case this section's own example describes: a gap too short for the obvious thing.

---

## 5. Views

### Today — ruthless

- Only what is actionable today: `work_opens_at <= now`, not done.
- Timeline of today's calendar blocks, with the current block marked.
- Suggestion line.
- Queue sorted by score, filterable by category.
- Pending actions pinned at the top.
- Quick-add always reachable — one tap from the top on mobile.

### Week — capacity, not just deadlines

The question being answered is "where does this fit," which a list of due dates does not answer.

- Seven columns, free calendar blocks drawn to scale.
- Tasks placed in the day their `work_opens_at` falls, sized by `est_minutes`.
- **Drag a task to another day** → sets an explicit work window and writes a `rank_events` lead-time signal.
- Visible over-capacity warning when a day's placed tasks exceed its free time.

Today and Week must stay genuinely different. Today is for doing; Week is for planning. Do not let Today become a wall of everything.

### Quick-add

Single text field. Parse natural language for date and course: `"call CPD Thursday"` → owned task, category admin, due Thursday. Always show the parsed result before saving so a bad parse is visible. This is the feature that converts the page from a mirror into your real running list — if it is awkward, you will keep a second list elsewhere and the whole system fails.

---

## 6. Action tiers

**Tier 1 — silent.** No approval, no notification. Reversible and invisible.
- File Canvas wrap slides into a per-course folder on the laptop (e.g. `C:\Users\<you>\Documents\HBS\<COURSE>\Wrap Slides`)
- Sync assignments, calendar, 12Twenty events
- Attach a conferencing link to an event at high confidence (see §7)
- Update the Class Log and master tracker

**Tier 2 — queued, one tap.**
- Register for a 12Twenty or club event
- Create a calendar event from an email
- Attach a conferencing link at low confidence (show both candidate events)
- Send an email — **draft only at launch, see below**

**Tier 3 — never automated.**
- Anything involving money or payment
- Anything to a professor
- Anything to a recruiter or contact not previously corresponded with
- Anything deleting or submitting to Canvas

### Email send flag

**Not built.** Today the console only drafts: outreach text appears for you to copy, and no code path sends email. `EMAIL_SEND_ENABLED` is reserved in `.env.example` for when a send path exists; nothing reads it yet. If you add one, gate it on that flag, default it to `false`, and leave it off until drafts have been consistently right for weeks. The cost of being wrong is an email to a recruiter that cannot be unsent.

### Queue health

Target roughly 1–5 pending actions per day. Consistently more means a Tier 2 item should move to Tier 1. Consistently fewer means the agent is not scanning aggressively enough.

---

## 7. Conferencing-link enricher

Finding a Zoom URL in an email is trivial. **Matching it to the right calendar event is the actual problem.**

Scoring:
- Sender domain or name appears in an event title: **+0.4**
- Email names a date/time within 15 minutes of exactly one event: **+0.4**
- Only one candidate event in the referenced window: **+0.2**

Behavior:
- `>= 0.8` and exactly one candidate → Tier 1, write it silently.
- Otherwise → Tier 2 action showing **all** candidate events, one tap to pick.
- Zero candidates → Tier 2 `create_calendar_event` instead.

Extend the same mechanism to room numbers, dial-ins, reschedules, and cancellations — these are more common than new Zoom links and break the calendar in the same way.

---

## 8. Worker

Runs continuously whenever the laptop is awake (`npm run worker`). On Windows, a scheduled task triggered at logon, plus a wake handler. Plain-API sources (Canvas, Gmail, Google Calendar, job boards) can also run in the cloud on a schedule; browser-session sources and anything that acts on your behalf stay on the laptop. The two halves report separate heartbeats so a cloud run never makes a dead laptop look alive.

One-time sign-ins: `npm run worker:google-auth`, `npm run worker:outlook-login`, `npm run worker:12twenty-login`.

### Intervals — deliberately unequal

| Source | Interval | Why |
|---|---|---|
| Gmail | 3 min | Cheap, and freshness is the point |
| Google Calendar | 3 min | Same |
| Outlook (browser) | 15 min | Browser session, heavier |
| Canvas | 45 min | Assignments do not appear minute to minute |
| 12Twenty | 3 hours | Most fragile, full browser session. **Do not poll aggressively** — risks rate-limiting and session loss. |
| Action poll | 60 sec | Approvals should feel immediate |

### Behavior

- Push is a diff, not a full replace. Match `mirrored` tasks on `source_id`; never touch `owned` rows.
- Heartbeat every 60s. If the API has not heard from the worker in **1 hour**, the UI shows a worker-offline banner.
- A failing source sets its own `sources.status` to `error` and does not block the others. 12Twenty failing must never stop the Canvas sync.
- **Fail loudly.** A silent 12Twenty failure means missed recruiting deadlines. Surface it on the dashboard, not in a log file.
- Never store HBS credentials in the cloud. Browser sessions stay local, always.

---

## 9. API routes

```
POST /api/worker/push        bearer auth — state diff from worker
POST /api/worker/heartbeat   bearer auth
GET  /api/worker/actions     bearer auth — approved actions to execute
POST /api/worker/actions/:id bearer auth — report done/failed

GET  /api/state              session auth — everything the UI renders
POST /api/tasks              create owned task (quick-add)
PATCH /api/tasks/:id         toggle done; edit only if origin=owned
POST /api/actions/:id        approve | skip
PATCH /api/weights           edit scoring weights
POST /api/rank-events        log a selection mismatch
```

---

## 10. Build order

1. Auth, DB schema, `/api/state`, Today view with hardcoded seed data
2. Canvas + Google Calendar sync through the worker → Today shows real data on phone
3. Quick-add and owned tasks
4. Week view with drag-to-reschedule
5. 12Twenty and Outlook browser sources
6. Action queue: `register_event` first (low stakes, reversible)
7. Conferencing-link enricher
8. Scoring, weights settings page, suggestion line
9. `rank_events` logging, then the adaptation rules
10. Email drafts, send flag off

Steps 1–3 are the majority of the value. Ship them before starting 4.

---

## 11. Non-goals and guardrails

- **Never scrape LinkedIn.** LinkedIn signal arrives only through job-alert and notification emails parsed from Gmail.
- No writes back to Canvas — no submissions, no edits, ever. Read-only.
- No second user, no sharing, no public routes.
- No feature that requires you to maintain data by hand. Everything except quick-add must stay true with zero upkeep — the realistic failure mode is that recruiting gets loud, upkeep stops, the data goes stale, and you stop opening it.
- Do not add a feature because it is easy. Overwhelming systems get abandoned. Fewer surfaces, less to approve, one page.

---

## Appendix — environment gotchas

- **Install Node first.** On a fresh Windows machine Node and npm may be missing: `winget install OpenJS.NodeJS.LTS`.
- **OneDrive.** If the repo lives inside a OneDrive-synced folder (e.g. `C:\Users\<you>\OneDrive\Desktop\...`), pause sync before `npm install`; sync holds file locks that break installs.
- **No Graph access to HBS Outlook.** HBS runs its own Microsoft tenant and **blocks third-party Graph connectors** (AADSTS50105, app assignment required). Outlook is browser-only.
- On Outlook web, script injection may be blocked but page-text extraction works. Reading the calendar is cheap.
- **Optional: forward HBS mail to Gmail.** In Outlook web, forward all mail to `you@gmail.com` with a copy kept, then add a Gmail filter on `to:you@mba20XX.hbs.edu` that applies an `HBS` label. This lets the Gmail API see school mail too.
- **Canvas course codes.** Look up the `course_code` Canvas reports for each of your sections with `npm run canvas:check`, and set `canvasCode` per course in `lib/profile.json` if it differs from the `CODE-SECTION` default. Do not hard-code course IDs.
- **Google Calendar is usually incomplete for school life** (class sessions, club and CPD events often exist only in Outlook). Outlook is the more complete record of the school calendar, which is why reconciliation mirrors Outlook-only events into Google.
