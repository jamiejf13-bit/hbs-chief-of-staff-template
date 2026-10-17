// A very small .xlsx reader.
//
// An .xlsx is a zip of XML. Node can inflate a deflate stream on its own, so
// the only missing piece is walking the zip's central directory — about forty
// lines. That is cheaper than a dependency, and this only ever has to read one
// known file maintained by hand.
//
// It reads values, not formulas or formatting. Dates come back as Excel serial
// numbers and are converted here, because 46265 is not a date to anyone.

import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/** Every entry in the zip, by name. */
function unzip(buf) {
  // The end-of-central-directory record is at the end, after a comment of
  // unknown length, so it has to be found by scanning backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra fields, at their own lengths.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const textOf = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};

const decode = (s) =>
  s.replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .trim();

/**
 * Excel counts days from 1900-01-01, and believes 1900 was a leap year. The
 * 25569 offset absorbs both that and the Unix epoch.
 */
export function excelDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 1) return null;
  return new Date(Math.round((n - 25569) * 86_400_000));
}

/**
 * One sheet as an array of rows of cell values.
 *
 * Strings arrive as indexes into a shared table; numbers are inline. Empty
 * cells are skipped by Excel rather than emitted, so cells are placed by their
 * column letter and gaps come back as null — otherwise every row after a blank
 * would be shifted left.
 */
export function readSheet(path, sheetName) {
  const files = unzip(readFileSync(path));

  const get = (name) => {
    const f = files.get(name);
    if (!f) throw new Error(`${name} missing from the workbook`);
    return f.toString('utf8');
  };

  /**
   * Optional. Excel usually pools repeated text into sharedStrings.xml, but a
   * workbook written by another tool may store every string inline instead —
   * some trackers do, and looking the table up unconditionally failed with
   * "sharedStrings.xml missing" on a workbook that was perfectly readable.
   */
  const sharedXml = files.get('xl/sharedStrings.xml');
  const shared = sharedXml ? textOf(sharedXml.toString('utf8'), 'si').map(decode) : [];

  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');

  const sheet = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)]
    .find(([, name]) => name === sheetName);
  if (!sheet) throw new Error(`No sheet named "${sheetName}"`);

  /**
   * Attribute order is not guaranteed.
   *
   * Excel writes Id before Target; some other tools write Target before
   * Id, and a single pattern expecting one order found nothing
   * in a file that was perfectly well formed. So each Relationship element is
   * matched whole and its attributes read separately.
   */
  const target = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map(([, attrs]) => ({
      id: attrs.match(/\bId="([^"]+)"/)?.[1],
      to: attrs.match(/\bTarget="([^"]+)"/)?.[1],
    }))
    .find((r) => r.id === sheet[2])?.to;
  if (!target) throw new Error(`No relationship for ${sheet[2]}`);
  const xml = get(`xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`);

  const rows = [];
  for (const rowXml of textOf(xml, 'row')) {
    const cells = [];
    for (const m of rowXml.matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>|<c\s([^>]*)\/>/g)) {
      const attrs = m[1] ?? m[3] ?? '';
      const inner = m[2] ?? '';
      const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1];
      const col = ref ? ref.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1 : cells.length;
      const type = attrs.match(/t="([^"]+)"/)?.[1];

      let value = null;
      if (type === 's') {
        const idx = Number(decode(textOf(inner, 'v')[0] ?? ''));
        value = shared[idx] ?? null;
      } else if (type === 'inlineStr') {
        value = decode(inner);
      } else {
        const v = textOf(inner, 'v')[0];
        value = v == null ? null : decode(v);
      }

      while (cells.length < col) cells.push(null);
      cells[col] = value === '' ? null : value;
    }
    rows.push(cells);
  }
  return rows;
}
