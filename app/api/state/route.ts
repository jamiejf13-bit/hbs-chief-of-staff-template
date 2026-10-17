import { NextResponse } from 'next/server';
import { getState } from '@/lib/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const state = await getState();
    return NextResponse.json(state, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (err) {
    // A database that is down must say so on screen, not render an empty day
    // that looks like "nothing to do" (spec §8, fail loudly).
    const message = err instanceof Error ? err.message : 'Unknown database error';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
