// Shared helpers for the XR room emulator scripts (run through the plan's emu.sh, which provides ./emu-lib.mjs).
// `page(fn, arg)` runs a function inside the app page through `iwsdk browser run` and returns its JSON result.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { iwsdk } from './emu-lib.mjs';

const DIR = path.join(process.env.EMU_APP_DIR, '.emu');
let n = 0;

/** Runs fn(arg) in the app page (or its runtime frame) and returns the value. */
export async function page(fn, arg = null) {
  const file = path.join(DIR, `act-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  return await target.evaluate(${fn.toString()}, ${JSON.stringify(arg)});
}
`,
  );
  const out = await iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '25000');
  const d = out && (out.data ?? out);
  return d && 'result' in d ? d.result : d;
}

/** Navigates the app page (or its runtime frame) to a same-origin path. */
export async function go(p) {
  const file = path.join(DIR, `go-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  await target.goto(new URL(${JSON.stringify(p)}, target.url()).href, { waitUntil: 'load' });
  return target.url();
}
`,
  );
  return iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '45000');
}

/** Waits until window.__xrApp exists (the world is slow to start on software WebGL). */
export async function waitApp(timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const ok = await page(() => !!globalThis.__xrApp).catch(() => false);
    if (ok === true) return;
    if (Date.now() > end) throw new Error('xr app did not start');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export const stats = () => page(() => globalThis.__xrApp.stats());

export const SAMPLE_ROUND = {
  status: 'live',
  elapsed_s: 312,
  total_s: 900,
  muted: false,
  captions: true,
  brief: {
    question: 'Design a URL shortener for a large social app.',
    lines: ['100M new links a day', 'Reads far outnumber writes', 'Links never expire'],
  },
};

export const SAMPLE_SUMMARY = {
  verdict: { label: 'Leaning hire', tone: 'good', provisional: false },
  bars: [
    { name: 'Requirements', score: 3 },
    { name: 'High level design', score: 3 },
    { name: 'Deep dive', score: 2 },
    { name: 'Communication', score: 4 },
  ],
  strength: 'You pinned down scale and read patterns before drawing anything.',
  fix: 'Say how the ID generator avoids collisions across regions.',
  canRetry: true,
};
