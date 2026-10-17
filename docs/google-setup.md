# Google API setup

Lets the worker read and write your Google Calendar, and optionally read Gmail and file
class-prep docs in Drive. About 20 minutes. Google rearranges this console often: if a step
below stops matching the screen, trust the screen (and ask Claude to update this file).

---

## Before you start: use a personal Google account

**HBS Google accounts cannot create Google Cloud projects** — HBS blocks it outright, and
the failure looks like a button that does nothing. Do every step below signed in as your
**personal Gmail**. Check the account picker (top right) before anything else; when the
account is right, the new-project page says "You have N projects remaining in your quota".

If your HBS mail is forwarded to Gmail, the Gmail half of the console sees it too — see
"Forwarding HBS mail" at the end.

## 1. Create the project and the OAuth client

1. **console.cloud.google.com**, signed in as your personal Gmail. Create a project
   (any name, e.g. `hbs-chief-of-staff`). Confirm the project selector shows it before
   continuing.
2. Enable the APIs in one pass:
   `console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com`
3. **Google Auth Platform → Get started.** Four steps: app name (e.g. "Chief of Staff"),
   **External** audience, your contact email, then tick the User Data Policy box and
   Create.
4. **Audience → Test users → Add users →** your personal Gmail → **Save**. Skip this and
   sign-in fails with *"Error 403: access_denied … can only be accessed by
   developer-approved testers"*.
5. **Clients → Create client → Desktop app.** Any name (e.g. `chief-of-staff-worker`).
6. Copy the client ID and secret into `.env.local`:
   ```bash
   node scripts/set-secret.mjs GOOGLE_CLIENT_ID
   ```
   ```bash
   node scripts/set-secret.mjs GOOGLE_CLIENT_SECRET
   ```
   Each prompts for the value and never prints it. The secret sits behind the
   **ⓘ "Information and summary"** item in the client's **⋮** menu; the **Download JSON**
   button hides at narrow window widths. You don't need the JSON file.

## 2. Connect

```bash
npm run worker:google-auth
```

Open the printed URL, check it says your personal Gmail, click through the
"unverified app" warning (**Advanced → Go to <your app name> (unsafe)** — it is your own
app), and approve. The refresh token is saved to `worker/.credentials/google-token.json`,
which is in `.gitignore` and never goes to Vercel.

### Optional scopes

Both are off by default. Set them in `.env.local`, then run `npm run worker:google-auth`
again — Google re-prompts and mints a token covering everything.

```
GOOGLE_GMAIL_SCOPE=true   # read Gmail: job alerts, recruiter mail, things needing a reply
GOOGLE_DRIVE_SCOPE=true   # upload class-prep docs to a folder the app creates
```

`gmail.readonly` is a *restricted* scope. That is harmless while the app is in Testing,
but it rules out publishing (below). The Drive scope is `drive.file`: it can only see
files this app created.

### Cloud sync

If you use the GitHub Actions half (`.github/workflows/sync.yml`), it needs the same
token as a secret. `npm run google:copy-token` puts it on your clipboard without printing
it; paste it into **GitHub → Settings → Secrets and variables → Actions →
GOOGLE_REFRESH_TOKEN**. Do this again every time you reconnect.

---

## The seven-day problem

While the app's publishing status is **Testing**, Google expires the refresh token after
**seven days**. The worker then stops syncing Google until you reconnect. It does not fail
silently: the `gcal` source turns red, and the page raises a banner saying Google needs
reconnecting and giving the command. Reconnecting is one minute:

```bash
npm run worker:google-auth
```

…then `npm run google:copy-token` and update the GitHub secret if you use cloud sync.

**Why not just publish the app?** Two walls:

1. **Branding needs a real domain.** Publishing an External app that asks for more than
   basic sign-in needs a live homepage and a privacy policy on a domain you own. The app
   ships `/about` and `/privacy` pages for exactly this, but Google won't accept a shared
   domain like `vercel.app`, so you'd need a custom domain.
2. **`gmail.readonly` is restricted.** A *production* app with a restricted scope needs an
   annual paid third-party security assessment. A Testing app does not. So publishing
   would cost you Gmail.

Calendar-only (Gmail off) plus a custom domain can be published; otherwise, reconnect
weekly. Most people reconnect weekly.

---

## Forwarding HBS mail (optional)

HBS Outlook has no API students can use, so the worker reads Outlook mail through the
browser session. If you'd rather see everything in one place, you can also forward HBS
mail to your personal Gmail (Outlook → Settings → Mail → Forwarding, keep a copy), and add
a Gmail filter on `to:you@mba20XX.hbs.edu` that applies a label such as `HBS`.
