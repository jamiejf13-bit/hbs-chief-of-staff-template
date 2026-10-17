// Apply db/schema.sql to the database in .env.local.
//   node scripts/migrate.mjs
//
// The schema is written to be idempotent (create ... if not exists, drop
// trigger before create), so running this twice is safe and is the normal
// way to apply a change.

import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

function loadEnv(url) {
  let raw = readFileSync(url, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Split SQL into statements. Line-based on purpose: a statement ends at a
 * line whose last non-comment character is a semicolon, unless we are inside
 * a dollar-quoted body ($$ ... $$).
 *
 * The schema's trigger function holds semicolons inside a $$ body, so a plain
 * split on ";" would tear it in half. Counting $$ per line toggles the state:
 * "as $$" opens, "$$ language plpgsql;" closes and ends the statement in the
 * same line, which is exactly how the file is written.
 */
function splitStatements(sql) {
  const out = [];
  let buf = [];
  let inDollar = false;

  for (const line of sql.split(/\r?\n/)) {
    buf.push(line);

    const dollarCount = (line.match(/\$\$/g) ?? []).length;
    if (dollarCount % 2 === 1) inDollar = !inDollar;

    if (inDollar) continue;

    const withoutComment = line.replace(/--.*$/, '').trimEnd();
    if (withoutComment.endsWith(';')) {
      out.push(buf.join('\n'));
      buf = [];
    }
  }
  if (buf.join('\n').trim()) out.push(buf.join('\n'));

  return out.map((s) => s.trim()).filter((s) => s.length > 0 && !isOnlyComments(s));
}

/**
 * True when every line is blank or a `--` comment.
 *
 * Deliberately not a regex. The obvious pattern for this, /^(\s*--.*\n?)+$/,
 * has nested quantifiers whose matches overlap, and on the schema's block
 * comment headers it backtracks exponentially — it hangs the process rather
 * than returning false. This is linear and cannot.
 */
function isOnlyComments(block) {
  return block.split('\n').every((line) => {
    const t = line.trim();
    return t === '' || t.startsWith('--');
  });
}

const env = loadEnv(new URL('../.env.local', import.meta.url));
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is not set in .env.local.');
  process.exit(1);
}

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const statements = splitStatements(schema);
const sql = neon(env.DATABASE_URL);

console.log(`Applying db/schema.sql — ${statements.length} statements\n`);

/**
 * Run one statement verbatim.
 *
 * This driver version exposes only the tagged-template form — there is no
 * sql.query() and no sql.unsafe(). A tag call is fn(strings, ...values), so a
 * single-element array with a matching .raw is a template with nothing
 * interpolated, which passes the statement through unchanged. Safe here
 * because the input is our own schema file, never user input.
 */
function run(statement) {
  const strings = [statement];
  strings.raw = [statement];
  return sql(strings);
}

let ok = 0;
for (const [n, stmt] of statements.entries()) {
  const label = stmt.replace(/\s+/g, ' ').slice(0, 68);
  try {
    await run(stmt);
    ok++;
    process.stdout.write(`  ok   ${label}\n`);
  } catch (err) {
    console.error(`\n  FAIL at statement ${n + 1}:\n  ${label}\n`);
    console.error(`  ${String(err?.message ?? err)}\n`);
    console.error('Nothing after this point was applied. Fix and re-run — the schema is idempotent.');
    process.exit(1);
  }
}

console.log(`\nApplied ${ok}/${statements.length} statements.`);
console.log('Run "node scripts/check-db.mjs" to confirm.');
