import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Which commit is actually serving.
 *
 * This exists because of a specific mistake. A commit failed to build,
 * so it never deployed — and the only way anyone checked was by fetching a
 * page and reading its behaviour. The previous deployment was still serving,
 * behaving exactly as the previous deployment should, which is
 * indistinguishable from "the new one shipped and did not work". An hour went
 * into diagnosing a phantom Next.js quirk that was really just a failed build.
 *
 * Behaviour cannot tell you whether a deployment happened. Identity can.
 *
 * Deliberately public, and deliberately nothing but identity: a commit SHA
 * of a private repository is not a secret, and gating this would make it
 * useless for the one job it has — answering the question before you are able
 * to sign in. It is NOT the old /api/health, which listed the names of every
 * environment variable on the deployment; that is why that one is gone.
 */
export async function GET() {
  return NextResponse.json(
    {
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      built_at: process.env.VERCEL_DEPLOYMENT_ID ? null : 'dev',
      now: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
