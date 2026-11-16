// Emulator run for the board's input on /dev/sheet (no server): with the scripted right hand (INPUT=hands) or held
// controllers (INPUT=controllers), two boxes are drawn, a line from one card's edge to the other connects them, and a
// suggestion is accepted. KIT=hld (system design, default) or lld (object design: boxes become class cards).
// Hands also run a calibration tap (where the app sees the pinch against where the script sent the hand) and draw
// the connector twice: once as the round scripts do (a short settle before the pinch) and once with the hand at rest
// first, to tell the emulator's few frames a second apart from an app problem. Every result goes to hands-board.json.
//   Emulator run (see README.md): INPUT, KIT; allow up to 30 minutes.
import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.EMU_APP_DIR;
copyFileSync(path.join(APP, 'e2e', 'input-lib.mjs'), path.join(here, 'input-lib.mjs'));
const { hold, pull, stroke, xr } = await import('./input-lib.mjs');

const INPUT = process.env.INPUT ?? 'hands';
const KIT = process.env.KIT ?? 'hld';
const DIR = path.join(APP, '.emu');
const SHOTS = process.env.EMU_SHOTS ?? '.';
const result = { input: INPUT, kit: KIT, steps: [], problems: [], calibration: null, connectors: [] };
let n = 0;
const log = (name, detail = null) => {
  result.steps.push({ name, detail, t: new Date().toISOString() });
  console.log(`== ${name}`, detail ? JSON.stringify(detail).slice(0, 1500) : '');
};
const problem = (what, detail) => {
  result.problems.push({ what, detail });
  log(`PROBLEM ${what}`, detail);
};
const save = () => writeFileSync(path.join(SHOTS, 'hands-board.json'), JSON.stringify(result, null, 2));

async function page(fn, arg = null) {
  const file = path.join(DIR, `hb-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  return await target.evaluate(${fn.toString()}, ${JSON.stringify(arg)});
}
`,
  );
  const out = await iwsdk('browser', 'run', path.relative(APP, file), '--timeout', '25000');
  const d = out && (out.data ?? out);
  return d && 'result' in d ? d.result : d;
}

async function go(p) {
  const file = path.join(DIR, `hb-go-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  await target.goto(new URL(${JSON.stringify(p)}, target.url()).href, { waitUntil: 'load' });
  return target.url();
}
`,
  );
  return iwsdk('browser', 'run', path.relative(APP, file), '--timeout', '45000');
}

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
  return along([[sx, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y], [sx + 0.8, y]], 1.5).map(([px, py]) => [px + (r() - 0.5) * 0.6, py + (r() - 0.5) * 0.6]);
}

const board = () =>
  page(() => {
    const b = globalThis.__boardxr.store.board;
    return {
      items: b.items.map((i) => ({ id: i.id, kind: i.kind, x: i.x, y: i.y, w: i.w, h: i.h })),
      edges: b.edges.map((e) => [e.from, e.to]),
      ghosts: b.ghosts.map((g) => g.op_id),
    };
  });
const pinches = () => page(() => globalThis.__boardxr.pinches.slice());
const toWorld = (pts, h) => page((a) => globalThis.__boardxr.toWorld(a.pts, a.h), { pts, h });
const r4 = (p) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4, z: Math.round(p.z * 1e4) / 1e4 });

// ---- hands ----
/** Pinch-draws through board points 1 cm above the sheet; `settleS` is the rest before the pinch closes. */
async function draw(points, { settleS = 0.3, holdS = 0.15, endS = 0.25, segment = 0.1 } = {}) {
  const w = (await toWorld(points, 1)).map(r4);
  const last = w[w.length - 1];
  const steps = [
    { label: 'reach', position: w[0], anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: settleS },
    { label: 'pinch', pinch: 1, duration: 0.15 },
    { label: 'hold', duration: holdS },
    ...w.slice(1).map((p, i) => ({ label: `p${i}`, position: p, duration: segment })),
    { label: 'hold end', duration: endS },
    { label: 'release', pinch: 0, duration: 0.15 },
    { label: 'lift', position: { x: last.x, y: last.y + 0.06, z: last.z }, duration: 0.3 },
  ];
  return xr('run-sequence', { device: 'hand-right', steps, body: 'auto', gaze: 'fixed', idleHand: 'keep' });
}
const drawSettled = (points) => draw(points, { settleS: 1.5, holdS: 0.5, endS: 0.8 });

async function tapHand(x, y, settleS = 0.3) {
  const [p] = (await toWorld([[x, y]], 1)).map(r4);
  const steps = [
    { label: 'reach', position: p, anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: settleS },
    { label: 'pinch', pinch: 1, duration: 0.12 },
    { label: 'release', pinch: 0, duration: 0.12 },
    { label: 'lift', position: { x: p.x, y: p.y + 0.06, z: p.z }, duration: 0.3 },
  ];
  return xr('run-sequence', { device: 'hand-right', steps, body: 'auto', gaze: 'fixed', idleHand: 'keep' });
}

// ---- controllers ----
let rayFrom = null;
async function strokeCtrl(points, mode) {
  const w = await toWorld(points, mode === 'far' ? 0 : 0.4);
  await stroke('right', { from: mode === 'far' ? rayFrom : null, points: w });
  if (mode === 'near') {
    const e = w.at(-1);
    await hold('right', { x: e.x, y: e.y + 0.1, z: e.z + 0.1 }, { x: e.x, y: e.y + 0.3, z: e.z - 0.5 });
  }
  await sleep(500);
}
async function tapCtrl(x, y) {
  const [p] = await toWorld([[x, y]], 0);
  await hold('right', rayFrom, p);
  await sleep(1200);
  await pull('right', 0.7);
  await sleep(500);
}

// Seated at the home office desk (top 0.74 m, near edge z -1.7), leaning over the sheet.
const HEAD = { x: 0, y: 1.2, z: -1.56 };
const LOOK = { pitch: -52, yaw: 0, roll: 0 };
const shot = async (name) => {
  await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: LOOK });
  await sleep(600);
  await screenshot(`${INPUT}-${KIT}-${name}`).catch((e) => log(`shot ${name} failed`, String(e).slice(0, 200)));
};

await waitReady();
await go(`/dev/sheet?kit=${KIT}`);
for (let i = 0; i < 45; i++) {
  if ((await page(() => !!globalThis.__boardxr).catch(() => false)) === true) break;
  await sleep(2000);
}
await enterXR();
await sleep(1500);
await call('xr', 'set-input-mode', { mode: INPUT === 'controllers' ? 'controller' : 'hand' });
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: LOOK });
const desk = await page((d) => globalThis.__boardxr.placeDesk(d), { origin: { x: 0, y: 0.745, z: -1.74 }, yaw: 0, deskY: 0.745 });
log('desk', desk);
// The board's own sample cards are cleared, so only what this run draws is on the sheet.
await page(() => {
  const s = globalThis.__boardxr.store;
  for (const it of s.board.items.slice()) s.apply({ op_id: `clr-${it.id}`, src: 'hand', op: 'item.delete', args: { id: it.id } });
  return s.board.items.length;
});
if (INPUT === 'controllers') {
  [rayFrom] = await toWorld([[32, 56]], 22);
  await hold('left', { x: -0.4, y: 0.9, z: -1.45 }, { x: -0.4, y: 0.85, z: -2.4 });
} else {
  await call('xr', 'set-transform', { device: 'hand-left', position: { x: -0.4, y: 0.85, z: -1.45 }, orientation: 'auto' });
}
await sleep(800);

// 0. Hands: where a pinch lands. An empty-sheet tap makes no mark; the board logs where it went down.
if (INPUT === 'hands') {
  const target = [32, 34];
  await tapHand(...target);
  await sleep(600);
  const quick = (await pinches()).at(-1) ?? null;
  await tapHand(target[0], target[1], 1.5);
  await sleep(600);
  const settled = (await pinches()).at(-1) ?? null;
  const err = (p) => (p ? Math.round(Math.hypot(p.x_cm - target[0], p.y_cm - target[1]) * 100) / 100 : null);
  result.calibration = { target, quick, quick_err_cm: err(quick), settled, settled_err_cm: err(settled) };
  log('calibration', result.calibration);
}

/** Draws a box; returns the new card or null. */
async function box(x, y, seed, mode) {
  const before = (await board()).items.length;
  const pts = roughBox(x, y, 12, 7, seed);
  if (INPUT === 'hands') await draw(pts);
  else await strokeCtrl(pts, mode);
  await sleep(800);
  const b = await board();
  const made = b.items.length > before ? b.items.at(-1) : null;
  log(`box at ${x},${y}`, { made, kinds: b.items.map((i) => i.kind) });
  if (!made || made.kind === 'ink') problem(`the box at ${x},${y} did not become a card`, b.items);
  return made && made.kind !== 'ink' ? made : null;
}

/** A line from card a's right edge to card c: a connection. */
async function connect(a, c, how) {
  const from = [a.x + a.w + 0.4, a.y + a.h / 2];
  const to = [c.x + 2, c.y + c.h / 2 + 0.3];
  const pts = along([from, to], 1.5);
  const edgesBefore = (await board()).edges.length;
  const pinchesBefore = (await pinches()).length;
  if (INPUT === 'hands') await (how === 'settled' ? drawSettled(pts) : draw(pts));
  else await strokeCtrl(pts, how);
  await sleep(1000);
  const b = await board();
  const down = INPUT === 'hands' ? ((await pinches())[pinchesBefore] ?? null) : null;
  const ok = b.edges.length > edgesBefore;
  // Where the stroke started against the band that draws (the card's 0.8 cm rim inside, 1.4 cm outside its edge).
  const edgeX = a.x + a.w;
  const row = { how, from, down, start_vs_edge_cm: down ? Math.round((down.x_cm - edgeX) * 100) / 100 : null, connected: ok, moved: b.items.find((i) => i.id === a.id) };
  result.connectors.push(row);
  log(`connector (${how})`, row);
  return ok;
}

const near = INPUT === 'controllers' ? 'near' : null;
const far = INPUT === 'controllers' ? 'far' : null;
const c1 = await box(6, 4, 3, near);
const c2 = await box(40, 4, 5, far);
await shot('01-two-boxes');
if (c1 && c2) {
  const ok = await connect(c1, c2, INPUT === 'hands' ? 'quick' : 'far');
  if (!ok) problem('the line between the first two cards did not connect them', result.connectors.at(-1));
  await shot('02-connected');
}
// A second pair: hands draw this connector with the hand at rest before the pinch; controllers by touch.
const c3 = await box(6, 18, 7, near);
const c4 = await box(40, 18, 9, far);
if (c3 && c4) {
  const ok = await connect(c3, c4, INPUT === 'hands' ? 'settled' : 'near');
  if (!ok) problem('the line between the second pair did not connect them', result.connectors.at(-1));
  await shot('03-connected-2');
}

// A suggestion, accepted with a pinch (or the trigger). The pointer waits over it, so it does not settle by itself.
{
  const args =
    KIT === 'lld'
      ? { id: 'n_ghost', kind: 'class', label: 'Cache', class_kind: 'class', fields: [], methods: [], x: 22, y: 30, w: 10, h: 6 }
      : { id: 'n_ghost', kind: 'component', type: 'cache', label: 'Redis', x: 22, y: 30, w: 8, h: 5 };
  const cx = args.x + args.w / 2;
  const cy = args.y + args.h / 2;
  if (INPUT === 'hands') {
    const [p] = await toWorld([[cx, cy]], 3);
    await xr('run-sequence', { device: 'hand-right', steps: [{ label: 'hover', position: r4(p), anchor: 'grasp', duration: 0.5, pinch: 0 }], body: 'auto', gaze: 'fixed', idleHand: 'keep' });
  } else {
    const [p] = await toWorld([[cx, cy]], 0);
    await hold('right', rayFrom, p);
  }
  await sleep(300);
  await page((g) => globalThis.__boardxr.ghosts([g]), { op_id: 'g1', src: 'scribe', op: 'item.create', args });
  await shot('04-ghost');
  if (INPUT === 'hands') await tapHand(cx, cy);
  else await tapCtrl(cx, cy);
  await sleep(800);
  const b = await board();
  const sent = await page(() => globalThis.__boardxr.sent.map((o) => [o.op_id, o.src, o.op]));
  const accepted = b.items.some((i) => i.id === 'n_ghost') && !b.ghosts.length;
  log('ghost', { accepted, ghosts: b.ghosts, sent: sent.slice(-4) });
  if (!accepted) problem('the suggestion was not accepted', { b, sent });
  await shot('05-accepted');
}

result.final = await board();
result.pinches = INPUT === 'hands' ? await pinches() : null;
result.stats = await page(() => globalThis.__boardxr.stats?.() ?? null).catch(() => null);
save();
console.log(result.problems.length ? `hands-board: ${result.problems.length} problem(s)` : 'hands-board ok');
process.exit(result.problems.length ? 1 : 0);
