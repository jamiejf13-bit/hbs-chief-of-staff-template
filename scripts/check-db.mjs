// Connection and schema check.
//   node scripts/check-db.mjs
//
// Reads .env.local itself rather than relying on --env-file, because the file
// may carry a UTF-8 BOM from PowerShell's Set-Content, which the built-in
// parser does not tolerate.

import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const EXPECTED = [
  'actions', 'agent_runs', 'events', 'participation', 'rank_events',
  'sources', 'tasks', 'weight_changes', 'weights', 'worker_heartbeat',
];

function loadEnv(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`Could not read ${path}`);
    process.exit(1);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM

  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = loadEnv(new URL('../.env.local', import.meta.url));
const url = env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set in .env.local.');
  process.exit(1);
}

const host = url.replace(/^\w+:\/\/[^:]+:[^@]+@/, '').split('/')[0];
console.log(`Connecting to ${host} …`);

const sql = neon(url);

try {
  const rows = await sql`
    select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`;
  const found = rows.map((r) => r.table_name);

  console.log('\nConnection: OK');

  if (found.length === 0) {
    console.log('Tables:     none — db/schema.sql has not been run yet');
    process.exit(2);
  }

  console.log(`Tables:     ${found.length} found`);
  const missing = EXPECTED.filter((t) => !found.includes(t));
  const extra = found.filter((t) => !EXPECTED.includes(t));

  if (missing.length) console.log(`Missing:    ${missing.join(', ')}`);
  if (extra.length) console.log(`Unexpected: ${extra.join(', ')}`);
  if (!missing.length) console.log('Schema:     complete');

  // row counts, so an empty-looking dashboard can be explained
  if (found.includes('tasks')) {
    const [{ n: tasks }] = await sql`select count(*)::int as n from tasks`;
    const [{ n: events }] = await sql`select count(*)::int as n from events`;
    const [{ n: acts }] = await sql`select count(*)::int as n from actions`;
    console.log(`\nRows:       tasks ${tasks} · events ${events} · actions ${acts}`);
    if (tasks === 0) {
      console.log('            (empty is expected until the worker runs)');
    }
  }

  process.exit(missing.length ? 2 : 0);
} catch (err) {
  console.error('\nConnection: FAILED');
  console.error(String(err?.message ?? err));
  process.exit(1);
}
