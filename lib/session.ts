// Single-user auth (spec §2): one shared password, one signed httpOnly cookie.
// No user table, no OAuth. Uses Web Crypto so middleware can verify on the Edge runtime.

export const COOKIE_NAME = 'console_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — this is a phone bookmark, not a bank

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Constant-time string compare — avoids leaking the signature a byte at a time. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueToken(secret: string): Promise<string> {
  return sign(`v1|${Date.now() + TTL_MS}`, secret);
}

export async function isValidToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  let expected: string;
  try {
    expected = await sign(payload, secret);
  } catch {
    return false;
  }
  if (!safeEqual(token, expected)) return false;

  const expiry = Number(payload.split('|')[1]);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

/**
 * Compares the submitted password against APP_PASSWORD in constant time.
 * Returns false when APP_PASSWORD is unset — an unconfigured deployment
 * must be closed, never open.
 */
export function passwordMatches(submitted: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return safeEqual(
    b64url(enc.encode(submitted)).padEnd(128, '.').slice(0, 128),
    b64url(enc.encode(expected)).padEnd(128, '.').slice(0, 128),
  );
}

export function cookieOptions(maxAgeSeconds = TTL_MS / 1000) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
