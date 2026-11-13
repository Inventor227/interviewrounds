// Shared helpers for the XR room emulator scripts. The runner provides ./emu-lib.mjs (IWSDK CLI helpers).
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
  // The runtime frame can be swapped while XR starts; retry a few times when the handle went stale.
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '25000');
      const d = out && (out.data ?? out);
      return d && 'result' in d ? d.result : d;
    } catch (e) {
      if (attempt >= 3 || !/different document|Execution context was destroyed|frame was detached/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
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

/** Sets the browser viewport (the managed page), returning the new size. */
export async function viewport(width, height) {
  const file = path.join(DIR, `vp-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page }) {
  await page.setViewportSize({ width: ${width}, height: ${height} });
  return page.viewportSize();
}
`,
  );
  return iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '20000');
}

/** Recent browser console lines (text only). */
export async function consoleLines(count = 300) {
  const out = await iwsdk('browser', 'logs', '--input-json', JSON.stringify({ count })).catch(() => null);
  const list = out?.data?.result ?? out?.result ?? [];
  return Array.isArray(list) ? list.map((l) => `[${l.level}] ${String(l.message ?? l.text ?? '')}`) : [];
}

/** Starts the desk placement (explicit since the app no longer places by itself). */
export const startPlacement = () => page(() => void globalThis.__xrApp.place().catch(() => {}));

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
