# Deploying to Vercel

Put your copy in a **private** GitHub repository first (`lib/profile.json` and
`lib/targets.json` describe you). If you started from the GitHub template, it already is —
just check the visibility says Private.

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
| `ANTHROPIC_API_KEY` | yes (assistant) | optional (duration estimates) | optional | Your own key; you pay Anthropic directly. |
| `CANVAS_TOKEN`, `CANVAS_BASE_URL` | **no** | yes | `CANVAS_TOKEN` | Reads Canvas as you. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | **no** | yes | yes | Google OAuth client. |
| `GOOGLE_REFRESH_TOKEN` | **no** | (file in `worker/.credentials/`) | yes | `npm run google:copy-token` |
| `GOOGLE_GMAIL_SCOPE`, `GOOGLE_DRIVE_SCOPE` | **no** | yes | — | Worker-only flags. |
| `EMAIL_SEND_ENABLED` | **no** | yes | — | Ships `false`. |

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
- Optional cloud sync: add the GitHub Actions secrets from the table above. Canvas,
  Google Calendar and Gmail then keep syncing every 20 minutes even with the laptop shut
  (see the header of `.github/workflows/sync.yml` for the schedule and the free-minutes
  budget).

## Custom domain (optional)

Not needed to use the app. It matters only if you want to publish the Google app to escape
the seven-day token expiry, which needs a homepage and privacy policy on a domain you own
(the app already serves `/about` and `/privacy`) — see `google-setup.md`.
