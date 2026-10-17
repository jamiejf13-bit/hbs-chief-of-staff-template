// Load the curated watchlist into the database, without touching your tracking.
//
//   node scripts/import-watchlist.mjs
//
// data/internships.json was the tracker's whole source of truth, imported at
// build time. The table is now that source, and this moves the file's
// roles across. Safe to re-run: roles are matched on their original id, so a
// corrected deadline in the file updates the row rather than making a second
// one.
//
// It never writes a `my_` column. Your status, date applied, notes and stars
// belong to you and are the one thing an import must not trample — the file
// has no opinion about them and must not be allowed to express one.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, db } from '../worker/lib.mjs';

const env = loadEnv();
const sql = db(env);

const data = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/internships.json', import.meta.url)), 'utf8'),
);

let added = 0;
let updated = 0;

for (const r of data.roles ?? []) {
  const res = await sql`
    insert into tracked_roles (
      origin, source_ref, company, role, function, locations, nyc_option,
      availability, deadline, timing, pay, blurb, link, link_check,
      keywords_key, priority
    )
    values (
      'watchlist', ${r.id}, ${r.company}, ${r.role}, ${r.function ?? null},
      ${r.locations ?? null}, ${r.nycOption ?? null}, ${r.status ?? null},
      ${r.deadline ?? null}, ${r.timing ?? null}, ${r.pay ?? null},
      ${r.notes ?? null}, ${r.link ?? null}, ${r.linkCheck ?? null},
      ${r.keywordsKey ?? null}, ${r.priority ?? null}
    )
    -- The index is partial (source_ref is not null), and Postgres will not
    -- infer a partial index unless the statement repeats its predicate.
    on conflict (origin, source_ref) where source_ref is not null do update
      set company = excluded.company,
          role = excluded.role,
          function = excluded.function,
          locations = excluded.locations,
          nyc_option = excluded.nyc_option,
          availability = excluded.availability,
          deadline = excluded.deadline,
          timing = excluded.timing,
          pay = excluded.pay,
          blurb = excluded.blurb,
          link = excluded.link,
          link_check = excluded.link_check,
          keywords_key = excluded.keywords_key,
          priority = excluded.priority,
          updated_at = now()
    returning (xmax = 0) as inserted`;

  if (res[0]?.inserted) added++; else updated++;
}

const [{ n }] = await sql`select count(*)::int n from tracked_roles`;
const [{ mine }] = await sql`
  select count(*)::int mine from tracked_roles
   where my_status is not null or applied_on is not null
      or my_notes is not null or starred`;

console.log(`watchlist roles in the file : ${(data.roles ?? []).length}`);
console.log(`  added                     : ${added}`);
console.log(`  refreshed                 : ${updated}`);
console.log(`rows in tracked_roles       : ${n}`);
console.log(`rows carrying your tracking : ${mine}  (never written by this script)`);
