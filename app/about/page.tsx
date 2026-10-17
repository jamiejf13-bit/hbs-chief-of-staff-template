import type { Metadata } from 'next';
import Link from 'next/link';
import { PROFILE } from '@/lib/profile';

export const metadata: Metadata = {
  title: PROFILE.appName,
  description:
    'A personal operating system for one HBS student: coursework, calendar, email and recruiting in one page.',
};

/**
 * The public front door.
 *
 * Google requires an application home page before an OAuth app can leave
 * Testing, and everything else here sits behind a password — so there was no
 * page to give it. This is that page: it says what the application is and who
 * it is for, and links to the privacy policy, which Google also requires.
 *
 * It deliberately shows no data. The console itself is one click away and
 * stays behind the login.
 */
export default function About() {
  return (
    <main className="legal">
      <h1>{PROFILE.appName}</h1>
      <p className="lede">
        A personal operating system for one first-year MBA student at Harvard Business School.
        It gathers coursework, calendar, email and recruiting into a single page so that none of
        them has to be remembered separately.
      </p>

      <h2>What it does</h2>
      <ul>
        <li>Pulls class assignments and preparation questions from Canvas.</li>
        <li>
          Keeps one calendar out of two that disagree — Google and the school&rsquo;s Outlook —
          and says which one needs correcting by hand.
        </li>
        <li>
          Reads email to surface the few messages that need an answer, and leaves the rest alone.
        </li>
        <li>
          Watches the school&rsquo;s careers system for recruiting events and people worth
          contacting.
        </li>
        <li>Estimates how long work will take, so a day can be judged before it starts.</li>
      </ul>

      <h2>Who it is for</h2>
      <p>
        One person. It is not a product, has no other users, and is not offered to anyone else.
        Everything it shows is that person&rsquo;s own information, and the page itself requires
        a password.
      </p>

      <h2>What it does with data</h2>
      <p>
        Nothing is sold, shared or used for advertising, and nothing is sent on anyone&rsquo;s
        behalf without being shown to them first. The <Link href="/privacy">privacy policy</Link>{' '}
        sets out what it reads and where that goes.
      </p>

      <p className="updated">
        <Link href="/login">Sign in</Link> · <Link href="/privacy">Privacy</Link>
      </p>
    </main>
  );
}
