// Emulator run for the device check (/diag): the page in 2D, then the headset test with scripted hands. Placement
// by an index touch on the home office desk, a short frame test (?quick=1), then the right hand holds a pinch on the
// dot, draws the 10 cm line, taps the five rings and pinches Done; the page then shows the numbers.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/diag.mjs --out plan/shots/diag
// Frame times here are software rendering and mean nothing; the run checks the flow and the screens.

import { execFile } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'xr-lib.mjs'), path.join(here, 'xr-lib.mjs'));
const { go, page } = await import('./xr-lib.mjs');

const DIR = path.join(process.env.EMU_APP_DIR, '.emu');
const SHOTS = process.env.EMU_SHOTS ?? '.';
const BIN = path.join(process.env.EMU_APP_DIR, 'node_modules/.bin/iwsdk');
let n = 0;

function xr(action, input) {
  return new Promise((resolve, reject) => {
    execFile(BIN, ['xr', action, '--input-json', JSON.stringify(input)], { cwd: process.env.EMU_APP_DIR, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      let out = stdout;
      try {
        out = JSON.parse(stdout);
      } catch {}
      if (err) return reject(new Error(`xr ${action} failed (exit ${err.code}): ${String(stderr || stdout).slice(-2000)}`));
      resolve(out);
    });
  });
}

/** A full-length screenshot of the 2D page at the given width. */
async function pageShot(name, width = 1000) {
  const file = path.join(DIR, `dg-shot-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  await target.evaluate(() => window.scrollTo(0, 0));
  const h = await target.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: ${width}, height: Math.min(Math.max(h, 700), 7000) });
  await page.waitForTimeout(400);
  await page.screenshot({ path: ${JSON.stringify(path.join(SHOTS, `${name}.png`))} });
  await page.setViewportSize({ width: 512, height: 512 });
  return h;
}
`,
  );
  return iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '40000');
}

const stage = () => page(() => globalThis.__diagXr?.test.stage ?? null).catch(() => null);
async function waitStage(want, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await stage();
    if (want.includes(s)) return s;
    if (Date.now() > end) throw new Error(`stage ${s}, wanted ${want.join(' or ')}`);
    await sleep(1500);
  }
}

const r4 = (p) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4, z: Math.round(p.z * 1e4) / 1e4 });
const toWorld = async (pts, h = 1) => (await page((a) => globalThis.__diagXr.toWorld(a.pts, a.h), { pts, h })).map(r4);
const seq = (steps) => xr('run-sequence', { device: 'hand-right', steps, body: 'auto', gaze: 'fixed', idleHand: 'keep' });

async function pinchAt(x, y, holdS) {
  const [p] = await toWorld([[x, y]]);
  return seq([
    { label: 'reach', position: p, anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: 0.3 },
    { label: 'pinch', pinch: 1, duration: 0.12 },
    { label: 'hold', duration: holdS },
    { label: 'release', pinch: 0, duration: 0.12 },
    { label: 'lift', position: { x: p.x, y: p.y + 0.06, z: p.z }, duration: 0.3 },
  ]);
}

async function drawLine(from, to) {
  const pts = Array.from({ length: 11 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10]);
  const w = await toWorld(pts);
  const last = w[w.length - 1];
  return seq([
    { label: 'reach', position: w[0], anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: 0.3 },
    { label: 'pinch', pinch: 1, duration: 0.15 },
    { label: 'hold', duration: 0.15 },
    ...w.slice(1).map((p, i) => ({ label: `p${i}`, position: p, duration: 0.1 })),
    { label: 'hold end', duration: 0.25 },
    { label: 'release', pinch: 0, duration: 0.15 },
    { label: 'lift', position: { x: last.x, y: last.y + 0.06, z: last.z }, duration: 0.3 },
  ]);
}

const HEAD = { x: 0, y: 1.2, z: -1.48 };
const LOOK_DOWN = { x: 0, y: 1.2, z: -1.56 };
const shot = async (name, head = HEAD, pitch = -16) => {
  await call('xr', 'set-transform', { device: 'headset', position: head, orientation: { pitch, yaw: 0, roll: 0 } });
  await sleep(800);
  await screenshot(name);
};
const results = () => page(() => globalThis.__diagXr.test.results);

await waitReady();
await go('/diag?offer=1&quick=1&fallback=120');
for (let i = 0; i < 45; i++) {
  if ((await page(() => document.querySelector('[data-test="diag-xr-state"]')?.dataset.stage).catch(() => null)) === 'idle') break;
  await sleep(2000);
}
console.log('2d page', JSON.stringify(await pageShot('diag-1-page')));

// The Start tap enters through the app; the tooling accepts the offered session if the tap alone did not.
await page(() => document.querySelector('[data-test="diag-xr-run"]').click());
await sleep(3000);
if (!(await page(() => !!globalThis.__diagXr.app.world.session).catch(() => false))) await enterXR();
await sleep(1500);
await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: -38, yaw: 0, roll: 0 } });
await call('xr', 'set-transform', { device: 'hand-left', position: { x: -0.3, y: 0.95, z: -1.58 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: 0.3, y: 0.95, z: -1.58 }, orientation: 'auto' });
await waitStage(['placing'], 60000);
await sleep(1500);
await screenshot('diag-2-placing');

// Index tip on the desk (top 0.74 m, near edge z -1.7).
await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'point' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: 0.04, y: 0.748, z: -1.74 }, anchor: 'index-tip', orientation: { fingers: [0, -0.85, -0.5], thumb: 'left' } });
await waitStage(['frames72', 'frames90', 'hands'], 40000);
await call('xr', 'set-transform', { device: 'hand-right', position: { x: 0.28, y: 0.8, z: -1.68 }, orientation: 'auto' });
await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'default' });
await shot('diag-3-frames');

await waitStage(['hands'], 60000);
await shot('diag-4-hold', LOOK_DOWN, -52);
await pinchAt(32, 22, 3.8);
await sleep(1000);
console.log('after hold', JSON.stringify((await results()).hands?.hold));
await drawLine([27, 22], [37, 22]);
await sleep(1000);
console.log('after line', JSON.stringify((await results()).hands?.line));
await shot('diag-5-targets', LOOK_DOWN, -52);
for (const [x, y] of [
  [14, 12],
  [50, 12],
  [32, 21],
  [14, 30],
  [50, 30],
]) {
  await pinchAt(x, y, 0.05);
  await sleep(500);
}
await sleep(800);
await shot('diag-6-done', LOOK_DOWN, -52);
await pinchAt(32, 21, 0.05);
await waitStage(['done', 'ended'], 30000);
await sleep(2000);
const r = await results();
console.log('results', JSON.stringify(r));
writeFileSync(path.join(SHOTS, 'diag-xr-results.json'), JSON.stringify(r, null, 1));
console.log('2d results', JSON.stringify(await pageShot('diag-7-results')));
