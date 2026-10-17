// Keep .next out of OneDrive.
//
// The project lives in OneDrive\Desktop, so OneDrive was syncing the build
// output: 174 files and 96MB rewritten on every build. Worse than wasteful —
// OneDrive turns a file it is mid-sync into a cloud placeholder, which is a
// reparse point, and readlink on a placeholder fails with EINVAL. That broke
// three builds in this project with `EINVAL: invalid argument, readlink`
// pointing inside .next. Nothing was wrong with the code any of those times.
//
// The fix is to make .next a junction into AppData\Local. OneDrive does not
// follow junctions — it sees a reparse point it did not create and leaves it
// alone — so the output sits outside the synced tree while still appearing at
// .next, where Next.js expects it.
//
//   AppData\Local\hbs-chief-of-staff\build\
//     .next\          <- the real build output, .next in the project points here
//     node_modules\   <- junction back to the project's packages
//
// The second junction is not optional. Node resolves a file to its REAL path
// before looking for packages, so `require('react/jsx-runtime')` from
// .next\server\pages\_document.js walks up from AppData, not from the project,
// and finds no node_modules at all. The first attempt at this compiled
// perfectly and then died at "Collecting page data" with
// `Cannot find module 'react/jsx-runtime'`. Putting a node_modules junction
// beside .next puts the project's packages back on that upward walk.
//
// This runs before dev/build/verify because deleting .next is the usual way to
// clear a bad build cache, and `rm -rf .next` takes the junction with it. Next
// would then recreate .next as an ordinary directory and the corruption would
// quietly come back. So the links are re-made every time, not assumed.
//
// A no-op where it does not apply: not Windows, not inside OneDrive, or running
// on Vercel, where the checkout is on Linux and .next is just a folder.

import { existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// fileURLToPath, not a hand-rolled conversion. The 12Twenty login script
// already lost an afternoon to `file://${path}` vs Node's `file:///C:/...`,
// and the first draft of this file compared a regex against a path it had
// mangled, decided the project was not in OneDrive, and silently did nothing.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

const BOX = join(process.env.LOCALAPPDATA ?? '', 'hbs-chief-of-staff', 'build');

/** [link inside the project or the box, what it should resolve to] */
const LINKS = [
  [join(ROOT, '.next'), join(BOX, '.next')],
  [join(BOX, 'node_modules'), join(ROOT, 'node_modules')],
];

function skip(why) {
  if (process.env.UNSYNC_VERBOSE) console.log(`unsync-build: skipped — ${why}`);
  process.exit(0);
}

if (process.platform !== 'win32') skip('not Windows');
if (process.env.VERCEL || process.env.CI) skip('CI build');
if (!process.env.LOCALAPPDATA) skip('no LOCALAPPDATA');

// Compared against the env var Windows sets, not a pattern match on the path.
// Somebody cloning this to C:\dev should get an ordinary .next directory.
const oneDrive = process.env.OneDrive ?? process.env.OneDriveConsumer ?? '';
if (!oneDrive || !ROOT.toLowerCase().startsWith(oneDrive.toLowerCase())) {
  skip('project is not inside OneDrive');
}

// node_modules has to exist before anything is linked at it, or the junction
// would be created pointing at nothing and `npm install` would later write
// through it into the box.
if (!existsSync(join(ROOT, 'node_modules'))) skip('no node_modules yet — run npm install first');

mkdirSync(join(BOX, '.next'), { recursive: true });

let changed = false;

for (const [link, want] of LINKS) {
  if (existsSync(link)) {
    // realpath resolves a junction to its target and a real directory to
    // itself, which is the whole test. This runs on every build, so a correct
    // link must be left strictly alone — relinking would throw away the
    // incremental cache it is protecting.
    let real = null;
    try {
      real = realpathSync(link);
    } catch {
      /* a half-synced placeholder can fail to resolve at all — treat as wrong */
    }
    if (real && real.toLowerCase() === want.toLowerCase()) continue;
    rmSync(link, { recursive: true, force: true });
  }

  // mklink is a cmd builtin — fs has no junction call, and a symlink would
  // need administrator rights where a junction does not.
  execFileSync('cmd', ['/c', 'mklink', '/J', link, want], { stdio: 'ignore' });
  changed = true;
}

if (changed) console.log(`unsync-build: .next -> ${join(BOX, '.next')} (outside OneDrive)`);
else if (process.env.UNSYNC_VERBOSE) console.log('unsync-build: .next already outside OneDrive');
