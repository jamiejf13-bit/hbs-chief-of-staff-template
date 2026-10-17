# Deploying to Vercel

Put your copy in a **private** GitHub repository first (`lib/profile.json` and
`lib/targets.json` describe you). A copy made with **Use this template** is only private
if you chose **Private** when creating it — check the badge next to the repository name,
and if it says Public, change it under Settings → General → Danger Zone.

## What goes where

The web app never talks to Canvas, Google or Outlook — it only reads Postgres and, for the
assistant, calls Anthropic. So very little goes to Vercel, and nothing there can be used to
impersonate you anywhere. Everything else stays on the laptop (and, for the cloud sync, in
GitHub Actions secrets).

| Variable | Vercel | Laptop `.env.local` | GitHub Actions secret | Why |
|---|:--:|:--:|:--:|---|
| `DATABASE_URL` | yes | yes | yes (cloud sync) | Everyone reads and writes the same Neon database. |
| `APP_PASSWORD` | yes | yes (for `npm run dev`) | — | The password on the login page. |
| `SESSION_SECRET` | yes | yes (for `npm run dev`) | — | Signs the session cookie. |
| `WORKER_TOKEN` | yes | yes | — | Reserved for an HTTP worker; set it anyway. |
| `ANTHROPIC_API_KEY` | yes (assistant) | optional (duration estimates) | — | Your own key; you pay Anthropic directly. |
| `CANVAS_TOKEN`, `CANVAS_BASE_URL` | **no** | yes | `CANVAS_TOKEN` | Reads Canvas as you. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | **no** | yes | yes | Google OAuth client. |
| `GOOGLE_REFRESH_TOKEN` | **no** | (file in `worker/.credentials/`) | yes | `npm run google:copy-token` |
| `GOOGLE_GMAIL_SCOPE`, `GOOGLE_DRIVE_SCOPE` | **no** | yes | — | Worker-only flags. |
| `EMAIL_SEND_ENABLED` | **no** | leave `false` | — | Reserved; nothing sends email today. |
| `HBS_ROOT`, `PARTICIPATION_XLSX` | **no** | optional | — | Local files the worker reads. |

Generate `APP_PASSWORD`, `SESSION_SECRET` and `WORKER_TOKEN` as long random strings:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

If a Vercel variable ever leaks, the damage is bounded by the login password — annoying,
not catastrophic.

## Steps

1. **vercel.com → Continue with GitHub.**
2. **Add New → Project → Import** your repository. Next.js is detected; leave the build
   settings alone.
3. **Environment Variables** — add `DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`,
   `WORKER_TOKEN` and `ANTHROPIC_API_KEY`, copying values from `.env.local`. Apply each to
   Production, Preview and Development.
4. **Deploy.** Put the URL (e.g. `https://your-app.vercel.app`) in `.env.local` as
   `API_BASE_URL` for reference.

Changed a variable later? Vercel only picks it up on the next deployment:
**Deployments → ⋯ → Redeploy**.

## After it is live

- Open the URL and enter `APP_PASSWORD`. You should see the same data as
  `localhost:3000`, because it is the same database.
- **The worker still runs on the laptop** (`npm run worker`). Vercel is a window onto the
  database, not a replacement for the worker. If the laptop sleeps, the page still loads
  and says how long ago the worker checked in.
- On your phone: open the URL, then **Share → Add to Home Screen**. It opens full-screen
  like an app.
- Optional cloud sync (GitHub Actions). It ships **off**: the scheduled runs skip until
  you turn it on, so a fresh copy doesn't fail and email you every 20 minutes. To turn
  it on, once the worker works on your laptop:
  1. GitHub → your repo → **Settings → Secrets and variables → Actions → Secrets**: add
     `DATABASE_URL`, `CANVAS_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
     `GOOGLE_REFRESH_TOKEN` (`npm run google:copy-token` copies the last one).
  2. **Actions → Sync → Run workflow** once, and check it goes green.
  3. **Settings → Secrets and variables → Actions → Variables**: add `SYNC_ENABLED` =
     `true`.

  Canvas, Google Calendar and Gmail then keep syncing every 20 minutes from 6am to
  midnight Eastern, even with the laptop shut (the header of
  `.github/workflows/sync.yml` explains the schedule and the free-minutes budget). Each
  time you reconnect Google, update `GOOGLE_REFRESH_TOKEN` too.

## Custom domain (optional)

Not needed to use the app. It matters only if you want to publish the Google app to escape
the seven-day token expiry, which needs a homepage and privacy policy on a domain you own
(the app already serves `/about` and `/privacy`) — see `google-setup.md`.
