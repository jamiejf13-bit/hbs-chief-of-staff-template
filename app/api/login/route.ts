import { NextResponse } from 'next/server';
import { COOKIE_NAME, cookieOptions, issueToken, passwordMatches } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let password = '';
  try {
    const body = await req.json();
    password = typeof body?.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret || !process.env.APP_PASSWORD) {
    return NextResponse.json(
      { error: 'Server is not configured. Set APP_PASSWORD and SESSION_SECRET.' },
      { status: 500 },
    );
  }

  if (!passwordMatches(password, process.env.APP_PASSWORD)) {
    // Deliberately slow and vague: one user, so there is no account to enumerate,
    // but a brute-force attempt should not be cheap.
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, await issueToken(secret), cookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, '', cookieOptions(0));
  return res;
}
