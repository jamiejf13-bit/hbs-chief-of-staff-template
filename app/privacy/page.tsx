import type { Metadata } from 'next';
import { PROFILE } from '@/lib/profile';

export const metadata: Metadata = {
  title: `Privacy — ${PROFILE.appName}`,
  description: `What ${PROFILE.appName} reads, where it keeps it, and who else sees it.`,
};

/**
 * The privacy policy, public by necessity.
 *
 * Google will not let an OAuth app leave Testing without a homepage and a
 * privacy policy on a domain the developer controls, and an app stuck in
 * Testing has its refresh tokens expired every seven days — which means
 * reconnecting Google weekly until the app is published.
 *
 * It is written to be true rather than to be boilerplate. This app has exactly
 * one user, who is also its developer, and saying so plainly is both the
 * honest description and the strongest privacy statement available.
 */
export default function Privacy() {
  const updated = 'October 2026';

  return (
    <main className="legal">
      <h1>Privacy</h1>
      <p className="lede">
        {PROFILE.appName} is a personal tool with a single user, who is also the person who
        built it. It exists to gather one student&rsquo;s own coursework, calendar and recruiting
        into one page. It has no other users and is not offered to anyone else.
      </p>

      <h2>What it reads</h2>
      <ul>
        <li>
          <strong>Google Calendar</strong> — events, so the page can show the day and add or move
          commitments the user asks it to.
        </li>
        <li>
          <strong>Gmail (read only)</strong> — message senders and subjects, to surface the few
          that need an answer and to pick out job alerts. It cannot send, delete or alter mail;
          the scope it holds does not permit it.
        </li>
        <li>
          <strong>Google Drive (files it creates only)</strong> — it uploads the user&rsquo;s own
          class preparation documents so they open as Google Docs. The scope reaches only files
          this app itself created; it cannot see anything else in Drive.
        </li>
        <li>
          <strong>Canvas, Outlook and the school&rsquo;s careers system</strong> — the
          user&rsquo;s own coursework, calendar and recruiting events.
        </li>
        <li>
          <strong>Anthropic (optional)</strong> — when the built-in assistant is used, the request
          and a summary of the next few days&rsquo; calendar and open to-dos are sent to
          Anthropic&rsquo;s API under the user&rsquo;s own API key, to produce the answer.
        </li>
      </ul>

      <h2>Where it goes</h2>
      <p>
        Into a private Postgres database used only by this application, and onto this website,
        which requires a password. Browser sessions for the school systems stay on the
        user&rsquo;s own laptop and are never uploaded.
      </p>

      <h2>Who else sees it</h2>
      <p>
        Nobody. Nothing is sold, shared, or used for advertising. There is no analytics, no
        tracking and no third-party scripts. Data is not used to train any model. The only
        external services involved are the ones listed above, which the data comes from, and the
        hosting and database providers that run the site.
      </p>

      <h2>Sending things</h2>
      <p>
        The application drafts messages but does not send them. It contains no code that sends
        email, and anything that would act on the user&rsquo;s behalf — registering for
        an event, adding a calendar entry — is shown to them for approval first.
      </p>

      <h2>Removing access</h2>
      <p>
        Access can be withdrawn at any time at{' '}
        <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">
          myaccount.google.com/permissions
        </a>
        , which immediately stops this application reading anything. The database can be deleted
        by its owner at any time, and with it everything described here.
      </p>

      <h2>Contact</h2>
      <p>
        This application is maintained by its only user. Questions about it can go to the address
        on the Google consent screen.
      </p>

      <p className="updated">Last updated {updated}.</p>
    </main>
  );
}
