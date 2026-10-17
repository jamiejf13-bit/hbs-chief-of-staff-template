// Verify the Canvas token works and show what it can see.
//   node scripts/check-canvas.mjs

import { readFileSync } from 'node:fs';

function loadEnv(url) {
  let raw = readFileSync(url, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const env = loadEnv(new URL('../.env.local', import.meta.url));
const token = env.CANVAS_TOKEN;
const base = env.CANVAS_BASE_URL || 'https://hbs.instructure.com';

if (!token) { console.error('CANVAS_TOKEN is not set.'); process.exit(1); }
if (token === 'PASTE_TOKEN_HERE') { console.error('CANVAS_TOKEN is still the placeholder.'); process.exit(1); }

const auth = { Authorization: `Bearer ${token}` };

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: auth });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} on ${path}${body ? ` — ${body.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

try {
  const me = await get('/api/v1/users/self/profile');
  console.log(`Authenticated as: ${me.name}${me.primary_email ? ` <${me.primary_email}>` : ''}`);
  console.log(`Token:            valid (${token.length} characters)\n`);
} catch (err) {
  console.error('Authentication FAILED');
  console.error(String(err.message));
  if (String(err.message).startsWith('401')) {
    console.error('\nA 401 means the token is wrong, expired, or was revoked.');
    console.error('Generate a new one: hbs.instructure.com -> Settings -> New Access Token');
  }
  process.exit(1);
}

const courses = await get('/api/v1/courses?enrollment_state=active&per_page=50');
console.log(`Active courses: ${courses.length}`);
for (const c of courses) {
  console.log(`  ${String(c.id).padEnd(6)} ${c.course_code ?? ''} — ${c.name ?? ''}`);
}

// Assignments are the point of this token: they fill the empty Assignments tab.
let total = 0;
let withDue = 0;
console.log('\nAssignments per course:');
for (const c of courses) {
  try {
    const items = await get(`/api/v1/courses/${c.id}/assignments?per_page=100`);
    const due = items.filter((a) => a.due_at).length;
    total += items.length;
    withDue += due;
    console.log(`  ${String(c.id).padEnd(6)} ${String(items.length).padStart(3)} assignments, ${due} with a due date`);
  } catch (err) {
    console.log(`  ${String(c.id).padEnd(6)} unreadable — ${String(err.message).slice(0, 60)}`);
  }
}
console.log(`\nTotal: ${total} assignments, ${withDue} carrying a due date.`);
