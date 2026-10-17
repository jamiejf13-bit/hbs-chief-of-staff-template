// The prep write-ups the HBS Daily task produces, attached to the class tasks.
//
//   02 Courses/FRC - Financial Reporting and Control/
//     Class Material/Circular AI Deals/
//       2026-10-02 Circular AI Deals - Prep.docx
//
// Those files are the actual preparation — eighteen thousand characters of
// terms, numbers and argument per case. Nothing connected that folder to this
// database, so "pull the write-ups for tomorrow's classes and add to my to-dos"
// got an honest refusal from the agent while both documents sat on disk,
// written that afternoon.
//
// Local-only, like the browser sources: the files live in OneDrive on the
// laptop and the cloud half cannot see them (spec §8 — a source that cannot run
// says so rather than reporting success over nothing).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log, markSource } from './lib.mjs';
import { PROFILE, COURSE_CODES } from './profile.mjs';
import { uploadAsGoogleDoc, DriveScopeMissing } from './drive.mjs';

// Override with HBS_ROOT in .env.local if your folder lives elsewhere.
const DEFAULT_ROOT = join(
  process.env.USERPROFILE || homedir(),
  'OneDrive', 'Documents', 'HBS',
);

/** `FRC - Financial Reporting and Control` -> `FRC`, and only configured courses. */
const COURSES = new Set(COURSE_CODES.map((c) => c.toUpperCase()));

/** `2026-10-02 Circular AI Deals - Prep (v2).docx` */
const PREP = /^(\d{4}-\d{2}-\d{2}) (.+?) - Prep(?: \(v(\d+)\))?\.docx$/i;

/**
 * A .docx is a zip, read here by hand rather than by adding a dependency.
 *
 * The project has four runtime dependencies and none of them are for file
 * formats. A zip central directory is sixty lines and the only two storage
 * methods Word emits are deflate and stored, so the whole of what is needed
 * fits in this file.
 */
function unzipMember(buf, want) {
  // End-of-central-directory signature, scanned from the tail. The comment
  // field can be 64KB, so that is how far back it is worth looking.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);

    if (name === want) {
      // The local header repeats the name and carries its own extra field,
      // which is usually a different length from the central one.
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(start, start + csize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`${want} is not in the archive`);
}

/**
 * OOXML to plain text.
 *
 * Paragraph ends become newlines BEFORE tags are stripped, because stripping
 * first would run every heading, bullet and number into one unreadable line —
 * the same mistake `notes` makes against `prompt`, where the structure is most
 * of what the content is.
 */
function docxText(path) {
  const xml = unzipMember(readFileSync(path), 'word/document.xml').toString('utf8');
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&') // last, so &amp;lt; does not become a tag
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Your local day, not UTC: a 7pm class is the next day in UTC. */
const ET = new Intl.DateTimeFormat('en-CA', {
  timeZone: PROFILE.timezone || 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
const etDate = (d) => ET.format(d instanceof Date ? d : new Date(d));

/** Every `* - Prep.docx` under a course's Class Material tree. */
function findPreps(root) {
  const out = [];
  const courses = join(root, '02 Courses');
  if (!existsSync(courses)) return out;

  for (const dir of readdirSync(courses, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const code = dir.name.split(' - ')[0].trim().toUpperCase();
    if (!COURSES.has(code)) continue;

    const material = join(courses, dir.name, 'Class Material');
    if (!existsSync(material)) continue;

    // One level of case folders, then the files. Walked rather than globbed so
    // `_to_delete` and anything else unexpected can be skipped explicitly.
    const stack = [material];
    while (stack.length) {
      const here = stack.pop();
      for (const e of readdirSync(here, { withFileTypes: true })) {
        if (e.name.startsWith('_') || e.name.startsWith('~$')) continue;
        const full = join(here, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }

        const m = PREP.exec(e.name);
        if (!m) continue;
        out.push({
          path: full,
          course: code,
          date: m[1],
          caseName: m[2],
          version: m[3] ? Number(m[3]) : 1,
          mtime: statSync(full).mtime,
        });
      }
    }
  }
  return out;
}

/**
 * Attach each class task the write-up for its course and its class date.
 *
 * Matched on course plus date rather than on the case name, even though the
 * task titles carry it — `FRC | Class 11: Circular AI Deals: Strategic
 * Flywheel or Fragile Stack?` against a folder called `Circular AI Deals`.
 * The subtitle, the colon and the truncation make that a fuzzy match with
 * several ways to be quietly wrong, and one class per course per day makes
 * course-and-date exact.
 */
export async function syncWriteups(sql, env, did, { root = env?.HBS_ROOT || DEFAULT_ROOT } = {}) {
  if (!existsSync(root)) {
    const why = `Write-up folder not found: ${root}`;
    await markSource(sql, 'writeups', false, why);
    did.push(`Write-ups FAILED — ${why}`);
    return { ok: false, reason: why };
  }

  let files;
  try {
    files = findPreps(root);
  } catch (err) {
    await markSource(sql, 'writeups', false, err.message);
    did.push(`Write-ups FAILED — ${err.message}`);
    return { ok: false, reason: err.message };
  }

  // Newest wins: `(v2)` over `(v1)`, and a later edit over an earlier one.
  const best = new Map();
  for (const f of files) {
    const key = `${f.course}|${f.date}`;
    const held = best.get(key);
    if (!held || f.version > held.version || (f.version === held.version && f.mtime > held.mtime)) {
      best.set(key, f);
    }
  }

  /**
   * Canvas class sessions only.
   *
   * Course plus date is exact for a class, but it is not exact for a task. The
   * first run attached the Twitter write-up to "Watch equity video" — a to-do
   * written by hand, same course, same day, nothing to do with the case. A
   * write-up belongs to the class session Canvas mirrors, so hand-added tasks
   * are left alone.
   */
  const tasks = await sql`
    select id, title, course, due_at, writeup_path, writeup_at,
           writeup_drive_id
      from tasks
     where category = 'class' and course is not null
       and source = 'canvas' and origin = 'mirrored'
       and due_at is not null and deleted_at is null
       and due_at > now() - interval '14 days'`;

  let attached = 0, refreshed = 0, unmatched = 0, failed = 0, uploaded = 0;
  let driveProblem = null;

  for (const t of tasks) {
    const f = best.get(`${t.course}|${etDate(t.due_at)}`);
    if (!f) { if (!t.writeup_path) unmatched++; continue; }

    // Skip the read entirely when the same file has not been touched since the
    // last pass. These are 18KB of text each and this runs every few minutes.
    const seen = t.writeup_at ? new Date(t.writeup_at) : null;
    if (t.writeup_path === f.path && seen && seen >= f.mtime) continue;

    let body;
    try {
      body = docxText(f.path);
    } catch (err) {
      log(`writeups: could not read ${f.path} — ${err.message}`);
      failed++;
      continue;
    }
    if (!body) { failed++; continue; }

    /**
     * Upload the .docx as a Google Doc, so the task carries something you can
     * click rather than only text you can read here.
     *
     * The text is stored either way. A Drive failure must not cost you the
     * write-up itself — losing the link is an inconvenience, losing the
     * content is the feature not working.
     */
    let drive = { id: t.writeup_drive_id, url: undefined };
    if (!driveProblem) {
      try {
        drive = await uploadAsGoogleDoc(env, {
          name: `${t.course} — ${f.caseName} (${f.date})`,
          buffer: readFileSync(f.path),
          existingId: t.writeup_drive_id,
        });
        uploaded++;
      } catch (err) {
        // A missing scope is the same answer for every remaining document, so
        // it is recorded once and the rest of the pass stops trying.
        if (err instanceof DriveScopeMissing) driveProblem = err.message;
        else log(`writeups: Drive upload failed for ${f.caseName} — ${err.message}`);
        drive = { id: t.writeup_drive_id, url: undefined };
      }
    }

    // writeup only. `response` is the owner's and is never touched by a sync.
    await sql`
      update tasks
         set writeup = ${body},
             writeup_path = ${f.path},
             writeup_at = ${f.mtime.toISOString()},
             writeup_drive_id = coalesce(${drive.id ?? null}, writeup_drive_id),
             writeup_url = coalesce(${drive.url ?? null}, writeup_url),
             updated_at = now()
       where id = ${t.id}`;

    if (t.writeup_path) refreshed++; else attached++;
  }

  // Green, but say what is missing. A source that reports success while
  // silently doing half its job is how a gap survives for a week.
  await markSource(sql, 'writeups', true, driveProblem);
  if (driveProblem) did.push(`Write-ups: text attached, but no Google Doc — ${driveProblem}`);

  if (attached || refreshed) {
    did.push(
      `Write-ups: ${attached} attached${refreshed ? `, ${refreshed} updated` : ''}` +
      `${uploaded ? `, ${uploaded} opened as Google Docs` : ''}` +
      ` (${best.size} prep documents on disk)`,
    );
  }

  return { ok: true, files: files.length, cases: best.size, attached, refreshed, uploaded, unmatched, failed, driveProblem };
}
