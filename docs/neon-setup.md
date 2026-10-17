# Neon database setup

Neon is hosted Postgres. It's where the console keeps your tasks, events and actions so
they survive restarts and can be read from your phone. The free tier is plenty for one
person. About 15 minutes.

---

## 1. Create the account and project

1. Go to <https://neon.tech> and sign up (**Continue with Google** with your personal
   Gmail is one less password).
2. It offers to create a project immediately.
   - **Project name:** anything, e.g. `hbs-chief-of-staff`
   - **Postgres version:** leave the default
   - **Region:** **AWS US East (N. Virginia)**. Vercel deploys to Virginia by default, and
     a database in the same region keeps every page load fast.
3. Create it.

## 2. Copy the connection string

Neon shows a **Connection string** panel right after the project is created (later:
**Dashboard → Connect**).

- If it offers a choice, take **Pooled connection** — it suits the many short-lived
  connections a serverless app makes.
- It looks like
  `postgresql://neondb_owner:XXXX@ep-something-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`
- **It contains your database password.** Don't paste it into chat, a document, or
  anywhere public.

## 3. Put it in `.env.local`

If you haven't yet, create the settings file from the example (in the project folder):

```bash
copy .env.example .env.local
```

Then set the value without it appearing on screen:

```bash
node scripts/set-secret.mjs DATABASE_URL
```

(Or open `.env.local` in Notepad and paste it after `DATABASE_URL=`, no quotes.)

## 4. Create the tables

The database starts empty. `db/schema.sql` defines every table.

```bash
npm run db:push
```

It applies the schema statement by statement and is safe to re-run — the schema uses
`create … if not exists` throughout, so re-running is the normal way to apply a change.

To check at any time:

```bash
npm run db:check
```

It reports the connection, which tables exist, anything missing, and row counts.

## 5. Restart and check

```bash
npm run dev
```

**Expect the page to look empty.** That is correct:

- The **"Sample data"** badge disappears — the console is now reading your real database.
- The database has nothing in it until the worker runs, so: no tasks, no events, an empty
  queue, every source "never synced", and a **Worker offline** badge.

Next: Canvas token and Google (README steps 4–5), then `npm run worker` fills it in.

## What goes where

`.env.local` stays on your laptop. When you deploy, you set `DATABASE_URL`,
`APP_PASSWORD`, `SESSION_SECRET`, `WORKER_TOKEN` (and `ANTHROPIC_API_KEY`) in Vercel's own
environment settings — see [`deploy.md`](deploy.md). The worker's credentials — Google
token, Canvas token, browser sessions — **never** go to Vercel.
