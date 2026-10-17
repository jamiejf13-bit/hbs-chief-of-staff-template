// Upload a .docx to Google Drive as a Google Doc, and keep it updated.
//
// The prep write-ups live as .docx in OneDrive on the laptop. A website cannot
// open those: a `file:///` link is blocked from an https page, and a phone
// has no access to the laptop's disk at all. Storing the extracted text got the
// content into the console but not into something you could open and edit —
// the prep should be a doc you can click to open in Google Docs, like the
// other files.
//
// So the worker uploads it with `?uploadType=multipart` and a target mimeType
// of `application/vnd.google-apps.document`, which makes Drive convert the Word
// file into a real Google Doc on the way in.
//
// Scope is `drive.file`, which reaches only files this app created. It cannot
// list, read or modify anything else you keep in Drive.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { googleRefreshToken } from './lib.mjs';
import { PROFILE } from './profile.mjs';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DOC_MIME = 'application/vnd.google-apps.document';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The folder everything lands in, created once and then reused. */
const FOLDER_NAME = `${PROFILE.appName} — Class Prep`;

export class DriveScopeMissing extends Error {}

let cachedToken = null;
let cachedUntil = 0;

/**
 * Was Drive actually granted?
 *
 * Asked of the stored token before anything is uploaded. Google answers a
 * token minted without the scope with a 401 "invalid authentication
 * credentials" — indistinguishable from an expired token unless you look at
 * what was granted — so the first version of this reported twenty-five
 * separate upload failures for one missing checkbox.
 */
function driveWasGranted() {
  try {
    const path = fileURLToPath(new URL('./.credentials/google-token.json', import.meta.url));
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    return /drive\.file|auth\/drive\b/.test(stored.scope ?? '');
  } catch {
    return false;
  }
}

/** The stored refresh token exchanged for an access token, cached until it expires. */
async function token(env) {
  if (!driveWasGranted()) {
    throw new DriveScopeMissing(
      'The Google token has no Drive scope. Set GOOGLE_DRIVE_SCOPE=true in .env.local and re-run "node worker/google-auth.mjs"',
    );
  }
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const refreshToken = googleRefreshToken(env);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tok = await res.json();
  if (!res.ok) throw new Error(`Google refused the refresh token: ${tok.error ?? res.status}`);

  cachedToken = tok.access_token;
  cachedUntil = Date.now() + (tok.expires_in ?? 3600) * 1000 - 60_000;
  return cachedToken;
}

async function api(access, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${access}`, ...(init.headers ?? {}) },
  });

  if (res.status === 403 || res.status === 401) {
    const body = await res.text();
    // Tell "the token has no Drive scope" apart from "Drive said no", because
    // the first is fixed by re-running google-auth and the second is not.
    if (/insufficient|scope|unauthorized_client|ACCESS_TOKEN_SCOPE/i.test(body)) {
      throw new DriveScopeMissing(
        'The Google token has no Drive scope. Set GOOGLE_DRIVE_SCOPE=true in .env.local and re-run "node worker/google-auth.mjs"',
      );
    }

    // The scope can be granted while the API itself is switched off in the
    // Cloud project — they are two different consents and Google only mentions
    // the second once you try to use it. Same shape of answer as a missing
    // scope: one click fixes every document, so say it once with the real URL
    // rather than failing each file with the link truncated.
    if (/has not been used in project|is disabled/i.test(body)) {
      const project = /project (\d+)/.exec(body)?.[1];
      throw new DriveScopeMissing(
        'The Google Drive API is switched off in your Google Cloud project. Enable it at ' +
          `https://console.cloud.google.com/apis/library/drive.googleapis.com${project ? `?project=${project}` : ''}` +
          ' — then it can take a minute to take effect.',
      );
    }
    throw new Error(`Drive ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

/** The console's own folder, found by name among the files it created. */
async function folderId(access) {
  const q = encodeURIComponent(
    `name = '${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const found = await api(access, `${DRIVE}/files?q=${q}&fields=files(id)&pageSize=1`);
  if (found.files?.length) return found.files[0].id;

  const made = await api(access, `${DRIVE}/files?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return made.id;
}

/**
 * Put `buffer` into Drive as a Google Doc and return { id, url }.
 *
 * When `existingId` is given the file is REPLACED in place rather than uploaded
 * again, so a rewritten write-up keeps the same link — a document you have
 * already opened, commented on or bookmarked does not become a second copy
 * every time the HBS Daily task touches it.
 */
export async function uploadAsGoogleDoc(env, { name, buffer, existingId = null }) {
  const access = await token(env);

  if (existingId) {
    try {
      const updated = await api(
        access,
        `${UPLOAD}/files/${existingId}?uploadType=media&fields=id,webViewLink`,
        { method: 'PATCH', headers: { 'content-type': DOCX_MIME }, body: buffer },
      );
      return { id: updated.id, url: updated.webViewLink };
    } catch (err) {
      if (err instanceof DriveScopeMissing) throw err;
      // The file was deleted in Drive, or the id is stale. Fall through and
      // make a new one rather than failing the whole sync over it.
    }
  }

  const parent = await folderId(access);

  // Multipart by hand: Drive wants the metadata and the bytes in one request,
  // and there is no helper here for that.
  const boundary = `cos${Date.now().toString(36)}`;
  const meta = JSON.stringify({ name, parents: [parent], mimeType: DOC_MIME });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\ncontent-type: ${DOCX_MIME}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const made = await api(access, `${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });

  return { id: made.id, url: made.webViewLink };
}
