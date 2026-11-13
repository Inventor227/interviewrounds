// Emulator run for the board in XR (/dev/sheet, a minimal passthrough scene): the scripted
// right hand pinch-draws a rough box, a second box and a line between them on the sheet,
// both cards get voice labels through the dev typed turn, then a Scribe ghost is accepted
// with a pinch. Screenshots of the sheet and of the wall board, and crisp board textures.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/board-xr.mjs --out plan/shots/board-xr
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { call, enterXR, iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

const DIR = path.join(process.env.EMU_APP_DIR, '.emu');
const SHOTS = process.env.EMU_SHOTS ?? '.';
let n = 0;

/** Runs fn(arg) in the app page (or its runtime frame) and returns the value. */
async function page(fn, arg = null) {
  const file = path.join(DIR, `bx-${++n}.mjs`);
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

/** Navigates the app page to a same-origin path. */
async function go(p) {
  const file = path.join(DIR, `bx-go-${++n}.mjs`);
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

/** Saves the sheet's board texture (what the wall board mirrors) as a PNG. */
async function saveBoard(name) {
  const file = path.join(DIR, `bx-snap-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  const url = await target.evaluate(() => globalThis.__boardxr.snapshot());
  const { writeFileSync } = await import('node:fs');
  if (url) writeFileSync(${JSON.stringify(path.join(SHOTS, `${name}-board.png`))}, Buffer.from(url.split(',')[1], 'base64'));
  return url.length;
}
`,
  );
  return iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '25000');
}

const fail = (msg, extra) => {
  console.error(msg, extra ? JSON.stringify(extra).slice(0, 2000) : '');
  process.exit(1);
};

// A hand-drawn wobble, deterministic.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function along(corners, step) {
  const out = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const k = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 0; j < k; j++) out.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
  }
  out.push(corners[corners.length - 1]);
  return out;
}
function roughBox(x, y, w, h, seed) {
  const r = rng(seed);
  const sx = x + w * 0.3;
  return along([[sx, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y], [sx + 0.8, y]], 1).map(([px, py]) => [px + (r() - 0.5) * 0.6, py + (r() - 0.5) * 0.6]);
}

const board = () =>
  page(() => {
    const b = globalThis.__boardxr.store.board;
    return {
      rev: b.rev,
      items: b.items.map((i) => ({ id: i.id, kind: i.kind, type: i.type ?? null, label: i.label ?? null, x: i.x, y: i.y, w: i.w, h: i.h })),
      edges: b.edges.map((e) => [e.from, e.to, e.dir]),
      ghosts: b.ghosts.map((g) => g.op_id),
      focus: b.focus,
    };
  });

/** Pinch-draws a stroke through board points (cm), 1 cm above the sheet. */
async function draw(points, segment = 0.07) {
  const w = await page((p) => globalThis.__boardxr.toWorld(p, 1), points);
  const last = w[w.length - 1];
  const steps = [
    { label: 'reach', position: w[0], anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: 0.3 },
    { label: 'pinch', pinch: 1, duration: 0.15 },
    { label: 'hold', duration: 0.15 },
    ...w.slice(1).map((p, i) => ({ label: `p${i}`, position: p, duration: segment })),
    { label: 'hold end', duration: 0.25 },
    { label: 'release', pinch: 0, duration: 0.15 },
    { label: 'lift', position: { x: last.x, y: last.y + 0.06, z: last.z }, duration: 0.3 },
  ];
  return call('xr', 'run-sequence', { device: 'hand-right', steps, body: 'fixed', gaze: 'fixed', idleHand: 'keep' });
}

/** A short pinch on a board point (select a card, accept a ghost). */
const tap = (x, y) => draw([[x, y]]);

/** Holds the hand over a board point, 3 cm up, without pinching. */
async function hover(x, y) {
  const [p] = await page((q) => globalThis.__boardxr.toWorld(q, 3), [[x, y]]);
  return call('xr', 'run-sequence', { device: 'hand-right', steps: [{ label: 'hover', position: p, anchor: 'grasp', duration: 0.5, pinch: 0 }], body: 'fixed', gaze: 'fixed', idleHand: 'keep' });
}

const shot = async (name) => {
  await sleep(600);
  await screenshot(name);
  await saveBoard(name).catch((e) => console.log(`board snapshot ${name}: ${String(e).slice(0, 200)}`));
};

await waitReady();
await go('/dev/sheet');
for (let i = 0; i < 45; i++) {
  if ((await page(() => !!globalThis.__boardxr).catch(() => false)) === true) break;
  await sleep(2000);
}
await enterXR();
await sleep(1500);
await call('xr', 'set-input-mode', { mode: 'hand' });

// Seated at the home office desk (top 0.74 m, near edge z -1.7), looking down at the sheet.
const HEAD = { x: 0, y: 1.2, z: -1.42 };
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: -48, yaw: 0, roll: 0 } });
const desk = await page((d) => globalThis.__boardxr.placeDesk(d), { origin: { x: 0, y: 0.745, z: -1.74 }, yaw: 0, deskY: 0.745 });
console.log('desk', JSON.stringify(desk));
await call('xr', 'set-transform', { device: 'hand-left', position: { x: -0.4, y: 0.85, z: -1.45 }, orientation: 'auto' });
await sleep(800);

// 1. A rough box becomes a service card.
await draw(roughBox(8, 10, 12, 7, 3));
await sleep(800);
let b = await board();
console.log('box 1', JSON.stringify(b.items));
if (b.items.length !== 1 || b.items[0].type !== 'service') fail('the rough box did not become a card', b);
await shot('xr-01-box');

// 2. A second box.
await draw(roughBox(40, 10, 12, 7, 5));
await sleep(800);
b = await board();
if (b.items.filter((i) => i.kind === 'component').length !== 2) fail('the second box did not become a card', b);
await shot('xr-02-two-boxes');

// 3. A line from the first card's edge to the second: a connection.
{
  const [a, c] = b.items;
  const from = [a.x + a.w - 0.3, a.y + a.h / 2];
  const to = [c.x + 2, c.y + c.h / 2 + 0.3];
  await draw(along([from, to], 1));
}
await sleep(800);
b = await board();
if (b.edges.length !== 1) fail('the line did not connect the cards', b);
await shot('xr-03-connected');

// 4. Voice labels through the dev typed turn: select a card with a short pinch, then say its name.
{
  const [a, c] = b.items;
  await tap(a.x + a.w / 2, a.y + a.h / 2);
  await sleep(500);
  console.log('say 1', await page((t) => globalThis.__boardxr.say(t), 'call that the order service'));
  await tap(c.x + c.w / 2, c.y + c.h / 2);
  await sleep(500);
  console.log('say 2', await page((t) => globalThis.__boardxr.say(t), 'call that the URL store'));
}
await sleep(500);
b = await board();
if (b.items[0].label !== 'Order service' || b.items[1].label !== 'URL store') fail('the voice labels did not land', b);
await shot('xr-04-labelled');

// 5. A Scribe ghost (a cache card). The hand hovers there first, so it waits for the pinch
//    instead of settling by itself after 4 s.
await hover(26, 30);
await sleep(300);
await page(
  (g) => globalThis.__boardxr.ghosts([g]),
  { op_id: 'g1', src: 'scribe', op: 'item.create', args: { id: 'n_cache', kind: 'component', type: 'cache', label: 'Redis', x: 22, y: 27.5, w: 8, h: 5 } },
);
await shot('xr-05-ghost');
await tap(26, 30);
await sleep(800);
b = await board();
const sent = await page(() => globalThis.__boardxr.sent.map((o) => [o.op_id, o.src, o.op]));
if (!b.items.some((i) => i.id === 'n_cache') || b.ghosts.length) fail('pinching the ghost did not accept it', { b, sent });
if (!sent.some(([id, src]) => id === 'g1' && src === 'scribe')) fail('the accepted ghost was not sent as a scribe op', sent);
await shot('xr-06-accepted');

// 6. The wall board mirrors the sheet.
await call('xr', 'set-transform', { device: 'hand-right', position: { x: 0.35, y: 0.85, z: -1.45 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: 6, yaw: 0, roll: 0 } });
await shot('xr-07-wall');

writeFileSync(path.join(SHOTS, 'board-xr.json'), JSON.stringify({ desk, board: b, sent }, null, 2));
console.log('board xr ok');
