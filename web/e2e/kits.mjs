// Emulator shots for the board kits of the other rounds, in the 2D sandbox (/dev/board?kit=...)
// with real mouse input, plus the coding panel standing beside the sheet in XR (/dev/sheet).
// Each kit: a few hand gestures, Scribe ops where the Scribe would write (voice text), checks,
// then a screenshot and a crisp render of the board.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/kits.mjs --out plan/shots/kits
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { call, enterXR, iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

const SHOTS = process.env.EMU_SHOTS ?? '.';
const DIR = path.join(process.env.EMU_APP_DIR, '.emu');
const results = {};
let n = 0;

const fail = (msg, extra) => {
  console.error(msg, extra ? JSON.stringify(extra).slice(0, 2000) : '');
  process.exit(1);
};

/** Runs `body` (an async function body with page, frame and helpers) in the managed browser. */
async function step(name, body, { shot = true, snapshotPx = 16 } = {}) {
  n += 1;
  const file = path.join(DIR, `kits-${n}.mjs`);
  writeFileSync(
    file,
    `const NAME = ${JSON.stringify(name)};
export default async function ({ page, frame }) {
  let ox = 0, oy = 0;
  const fe = await frame.frameElement().catch(() => null);
  if (fe) { const b = await fe.boundingBox(); if (b) { ox = b.x; oy = b.y; } }
  const client = (pts) => frame.evaluate((p) => p.map(([x, y]) => window.__board.toClient(x, y)), pts);
  const stroke = async (pts, steps = 6) => {
    const px = await client(pts);
    await page.mouse.move(px[0][0] + ox, px[0][1] + oy);
    await page.mouse.down();
    for (let i = 1; i < px.length; i++) {
      const [ax, ay] = px[i - 1];
      const [bx, by] = px[i];
      for (let s = 1; s <= steps; s++) await page.mouse.move(ax + ((bx - ax) * s) / steps + ox, ay + ((by - ay) * s) / steps + oy);
    }
    await page.mouse.up();
    await page.waitForTimeout(120);
  };
  const tap = async (x, y) => stroke([[x, y]]);
  const say = (text) => frame.evaluate((t) => window.__board.say(t), text);
  const scribe = (op, args) => frame.evaluate((o) => window.__board.scribe(o), { op, args });
  const board = () => frame.evaluate(() => JSON.parse(JSON.stringify(window.__board.store.board)));
  const slot = (name) => frame.evaluate((s) => window.__board.traySlot(s), name);
  const pull = async (name, to) => {
    const s = await slot(name);
    await stroke([[s.x + 3, s.y + s.h / 2], [Math.max(2, to[0] - 6), to[1]], to]);
  };
  const nav = async (kit) => {
    await frame.goto(new URL('/dev/board?kit=' + kit, frame.url()).href, { waitUntil: 'load' });
    await frame.waitForFunction((k) => window.__board && window.__board.kit === k, kit, { timeout: 45000 });
    await page.waitForTimeout(600);
  };
  const hires = async () => {
    const url = await frame.evaluate((px) => window.__board?.snapshot(px) ?? '', ${snapshotPx});
    if (!url || !process.env.EMU_SHOTS) return;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.EMU_SHOTS + '/' + NAME + '-board.png', Buffer.from(url.split(',')[1], 'base64'));
  };
  try {
    ${body}
  } finally {
    ${shot ? 'await hires().catch(() => {});' : ''}
  }
}
`,
  );
  const res = await iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '100000');
  const out = res?.data?.result ?? res?.result ?? res;
  results[name] = out;
  console.log(`${name}: ${JSON.stringify(out).slice(0, 500)}`);
  if (shot) {
    await sleep(400);
    await screenshot(name);
  }
  return out;
}

await waitReady();
await sleep(2000);

// ---------- Object design ----------
let r = await step(
  'lld',
  `await nav('lld');
  await pull('Class', [14, 13]);
  await say('call that ParkingLot');
  await pull('Abstract class', [44, 11]);
  await say('call that Level');
  await pull('Interface', [44, 30]);
  await say('call that PaymentGateway');
  let b = await board();
  const [lot, level, pay] = b.items;
  await scribe('member.add', { class_id: lot.id, section: 'fields', member: { id: lot.id + '_f1', vis: '-', name: 'levels', type: 'List<Level>' } });
  await scribe('member.add', { class_id: lot.id, section: 'fields', member: { id: lot.id + '_f2', vis: '-', name: 'gates', type: 'List<Gate>' } });
  await scribe('member.add', { class_id: lot.id, section: 'methods', member: { id: lot.id + '_m1', vis: '+', name: 'park', params: [{ name: 'v', type: 'Vehicle' }], returns: 'Ticket' } });
  await scribe('member.add', { class_id: lot.id, section: 'methods', member: { id: lot.id + '_m2', vis: '+', name: 'leave', params: [{ name: 't', type: 'Ticket' }], returns: 'Fee' } });
  await scribe('member.add', { class_id: level.id, section: 'fields', member: { id: level.id + '_f1', vis: '-', name: 'spots', type: 'List<Spot>' } });
  await scribe('member.add', { class_id: level.id, section: 'methods', member: { id: level.id + '_m1', vis: '+', name: 'freeSpots', params: [], returns: 'int' } });
  await scribe('member.add', { class_id: pay.id, section: 'methods', member: { id: pay.id + '_m1', vis: '+', name: 'charge', params: [{ name: 'fee', type: 'Fee' }], returns: 'Receipt' } });
  b = await board();
  const L = b.items[0];
  // Pull the ParkingLot tab to Level: a "uses" relation; tap its chip once: "has a".
  await stroke([[L.x + L.w + 0.5, L.y - 0.5], [36, 9], [46, 13]]);
  b = await board();
  const e = b.edges[0];
  const mid = await frame.evaluate((id) => {
    const bb = window.__board.store.board;
    const ed = bb.edges.find((x) => x.id === id);
    // Class cards grow with their rows (model.ts classLayout).
    const h = (it) => Math.max(it.h, 2.6 + 0.3 + Math.max(1, it.fields.length) * 1.6 + 0.6 + Math.max(1, it.methods.length) * 1.6 + 0.4);
    const c = (it) => [it.x + it.w / 2, it.y + h(it) / 2];
    const a = c(bb.items.find((i) => i.id === ed.from));
    const z = c(bb.items.find((i) => i.id === ed.to));
    return [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
  }, e.id);
  await tap(mid[0], mid[1]);
  // ParkingLot uses PaymentGateway.
  await stroke([[L.x + L.w + 0.5, L.y - 0.5], [30, 26], [44, 31]]);
  b = await board();
  return { classes: b.items.map((i) => [i.kind, i.class_kind, i.label, i.fields?.length, i.methods?.length]), edges: b.edges.map((x) => [x.from, x.to, x.rel]) };`,
);
if (r?.edges?.[0]?.[2] !== 'has_a' || r?.edges?.[1]?.[2] !== 'uses' || r?.classes?.[0]?.[2] !== 'ParkingLot') fail('lld kit', r);

// ---------- Product: lanes and the ladder ----------
r = await step(
  'pm',
  `await nav('pm');
  const notes = [
    ['user', 6, 'Commuters who drive'], ['user', 6, 'Visitors'],
    ['pain', 18, 'No spot after 9'], ['pain', 18, 'Late for standups'],
    ['idea', 30, 'Carpool app'], ['idea', 30, 'Shuttle from the station'], ['idea', 30, 'Book a spot ahead'],
    ['metric', 42, 'Weekly riders'],
  ];
  const seen = {};
  for (const [lane, x, text] of notes) {
    const i = seen[lane] = (seen[lane] ?? -1) + 1;
    await pull('Sticky note', [x, 8 + i * 8.5]);
    const b = await board();
    await scribe('item.label', { id: b.items[b.items.length - 1].id, text });
  }
  let b = await board();
  const pain = b.items.find((s) => s.text === 'No spot after 9');
  await scribe('sticky.vote', { id: pain.id, delta: 1 });
  await scribe('sticky.vote', { id: pain.id, delta: 1 });
  // Rank two ideas on the ladder: drag them onto rungs 1 and 2.
  const ideas = b.items.filter((s) => s.lane === 'idea');
  const rung = (r) => 3 + (r - 1) * 7.3 + 3.65;
  const c = (s) => [s.x + 3.5, s.y + 3.5];
  await stroke([c(ideas[2]), [44, rung(1)], [56.5, rung(1)]]);
  await stroke([c(ideas[0]), [44, rung(2)], [56.5, rung(2)]]);
  b = await board();
  return { lanes: b.items.map((s) => [s.lane, s.text, s.rank ?? null, s.votes]) };`,
);
const ranked = (r?.lanes ?? []).filter((s) => s[2] != null).map((s) => [s[2], s[1]]);
if (ranked.length !== 2 || !ranked.some((x) => x[0] === 1 && x[1] === 'Book a spot ahead')) fail('pm kit', r);

// ---------- Meeting ----------
r = await step(
  'meeting',
  `await nav('meeting');
  // Tick the first two agenda items.
  await tap(8, 5 + 1.2);
  await tap(8, 7.4 + 1.2);
  // Show the payback number on the screen.
  await stroke([[53.2 + 4, 4.6 + 2.5], [50, 20], [48, 31]]);
  await scribe('park.add', { text: 'Who covers client calls on Fridays?' });
  await scribe('park.add', { text: 'Can one team try it first?' });
  const b = await board();
  return { agenda: b.meeting.agenda.map((a) => [a.id, a.done]), shown: b.meeting.shown, parked: b.meeting.parked.length };`,
);
if (!r?.agenda?.[0]?.[1] || !r?.agenda?.[1]?.[1] || r?.shown?.[0]?.ref !== 'k3') fail('meeting kit', r);

// ---------- Coding ----------
const CODE = [
  ['l1', 0, 'def two_sum(nums, target):'],
  ['l2', 1, 'seen = {}'],
  ['l3', 1, 'for i, x in enumerate(nums):'],
  ['l6', 1, 'seen[x] = i'],
  ['l4', 2, 'if target - x in seen:'],
  ['l5', 3, 'return [seen[target - x], i]'],
  ['l7', 1, 'return []'],
];
r = await step(
  'coding',
  `await nav('coding');
  await scribe('code.approach', { lines: ['Hash map from value to index', 'One pass: look for target minus x before storing x'] });
  let after = null;
  for (const [id, indent, text] of ${JSON.stringify(CODE)}) {
    await scribe('code.insert', { line: { id, indent, text, src: 'scribe' }, after });
    after = id;
  }
  const P = await frame.evaluate(() => window.__board.panel);
  const row = (i) => P.y + 2.6 + i * 1.5 + 0.75;
  // seen[x] = i belongs after the if block, one level in: drag it down two rows and nudge it right.
  await stroke([[P.x + 10, row(3)], [P.x + 11, row(4)], [P.x + 10 + 2.6, row(5) + 0.5]], 8);
  // Complexity chips on the slots.
  await pull('O(n)', [12, 29]);
  await pull('O(n)', [34, 29]);
  // Walk the trace marker down four lines.
  await stroke([[P.x + 1.3, row(0)], [P.x + 1.3, row(1)], [P.x + 1.3, row(2)], [P.x + 1.3, row(3)], [P.x + 1.3, row(4)]], 4);
  const b = await board();
  return { lines: b.code.lines.map((l) => [l.id, l.indent]), complexity: b.code.complexity, trace: b.code.trace.map((t) => t.line) };`,
);
const order = (r?.lines ?? []).map((l) => l[0]).join(',');
if (order !== 'l1,l2,l3,l4,l5,l6,l7' || r?.lines?.[5]?.[1] !== 2 || r?.complexity?.time !== 'O(n)' || (r?.trace ?? []).length < 3) fail('coding kit', r);

// ---------- Coding panel in XR ----------
await step(
  'coding-xr-nav',
  `await frame.goto(new URL('/dev/sheet?kit=coding', frame.url()).href, { waitUntil: 'load' });
  await frame.waitForFunction(() => !!window.__boardxr, null, { timeout: 60000 });
  return true;`,
  { shot: false },
);
await enterXR();
await sleep(1500);
await call('xr', 'set-input-mode', { mode: 'hand' });
const HEAD = { x: 0, y: 1.2, z: -1.5 };
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: -32, yaw: -18, roll: 0 } });
await step(
  'coding-xr-seed',
  `const xr = (fn, arg) => frame.evaluate(fn, arg);
  await xr((d) => window.__boardxr.placeDesk(d), { origin: { x: 0, y: 0.745, z: -1.74 }, yaw: 0, deskY: 0.745 });
  const s = (op, args) => xr((o) => window.__boardxr.scribe(o), { op, args });
  await s('code.approach', { lines: ['Hash map from value to index', 'One pass'] });
  let after = null;
  for (const [id, indent, text] of ${JSON.stringify(CODE.filter((c) => c[0] !== 'l6'))}) {
    await s('code.insert', { line: { id, indent, text, src: 'scribe' }, after });
    after = id;
  }
  await s('code.complexity', { slot: 'time', value: 'O(n)' });
  await s('code.trace', { line: 'l3', t: 300 });
  return true;`,
  { shot: false },
);
await call('xr', 'set-transform', { device: 'hand-left', position: { x: -0.4, y: 0.85, z: -1.45 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: 0.45, y: 0.82, z: -1.45 }, orientation: 'auto' });
await sleep(2000);
await screenshot('coding-xr');

writeFileSync(path.join(SHOTS, 'kits.json'), JSON.stringify(results, null, 2));
console.log('kits ok');
