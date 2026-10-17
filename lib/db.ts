import { neon } from '@neondatabase/serverless';

export type Sql = ReturnType<typeof neon>;

let cached: Sql | null | undefined;

/**
 * Returns a query function, or null when DATABASE_URL is unset.
 *
 * Null is a supported state, not a failure: step 1 of the build order runs
 * the whole UI on seed data so the shape can be judged before Postgres
 * exists. Every caller must handle it.
 */
export function db(): Sql | null {
  if (cached !== undefined) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? neon(url) : null;
  return cached;
}

export function hasDb(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
