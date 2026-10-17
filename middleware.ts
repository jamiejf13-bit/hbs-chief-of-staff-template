import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, isValidToken } from '@/lib/session';

// Everything is gated except the login page and the login endpoint, plus the
// worker routes, which carry their own bearer token rather than a session
// cookie.
//
// /api/health used to sit here too. It existed to diagnose the empty Vercel
// environment variables, had to be reachable without signing in to do that
// job, and is gone now the job is done: it published the NAMES of every
// variable on the deployment — ANTHROPIC_API_KEY, DATABASE_URL, APP_PASSWORD,
// SESSION_SECRET — to anyone who asked. Never values, but a diagnostic that
// outlives its bug stops being a diagnostic.
/**
 * `/about` and `/privacy` are open because Google requires them to be.
 *
 * An OAuth app cannot leave Testing without a reachable home page and privacy
 * policy, and an app in Testing has its refresh tokens expired every seven
 * days — which is the reason Google has needed reconnecting weekly since this
 * was built. Both pages are prose about what the application is; neither shows
 * any data, and the console stays behind the password.
 *
 * Still a single literal string in the matcher below. Splitting it across an
 * expression once broke the build.
 */
const OPEN_PATHS = ['/login', '/api/login', '/api/version', '/about', '/privacy'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/api/worker/')) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // An unconfigured deployment is closed, never open.
    return deny(req, 'SESSION_SECRET is not set');
  }

  const ok = await isValidToken(req.cookies.get(COOKIE_NAME)?.value, secret);
  if (ok) return NextResponse.next();

  return deny(req, 'not signed in');
}

function deny(req: NextRequest, reason: string) {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: reason }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

/**
 * The app's own chrome is served without a session; everything else is gated.
 *
 * The manifest was already listed here and the icons it names were not, so
 * adding the console to a home screen fetched a manifest that resolved fine
 * and three icons that redirected to the login page. The icon is a letter
 * on a dark square and the manifest is the app's name: there is nothing in
 * either worth gating, and gating them only breaks the install.
 */
export const config = {
  // One literal string, not a concatenation: Next.js reads this at build time
  // and silently ignores a matcher it cannot analyse statically. Split across
  // two quoted parts with a +, it was ignored — the middleware then ran on
  // every request and the icons kept redirecting to the login page.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|icon-192.png|icon-512.png|apple-touch-icon.png).*)'],
};
