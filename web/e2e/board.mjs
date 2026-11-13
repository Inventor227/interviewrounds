// Emulator check for the board sandbox (/dev/board): draw a rough box, a second box and a
// line between them with the mouse, label one by a voice line, then add a card from the
// tray and connect it. Screenshots after each stage, plus the final board as JSON.
// Run with plan tooling: emu.sh <worktree> web/e2e/board.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

const SHOTS = process.env.EMU_SHOTS ?? '.';
const HERE = path.dirname(new URL(import.meta.url).pathname);

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
function along(corners, step = 0.3) {
  const out = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(corners[corners.length - 1]);
  return out;
}
function wobble(pts, amp, seed) {
  const r = rng(seed);
  const p1 = r() * 6.28;
  const p2 = r() * 6.28;
  return pts.map(([x, y], i) => [x + 0.6 * amp * Math.sin(i * 0.11 + p1) + 0.4 * amp * (r() * 2 - 1), y + 0.6 * amp * Math.sin(i * 0.13 + p2) + 0.4 * amp * (r() * 2 - 1)]);
}
function roughBox(x, y, w, h, seed) {
  const sx = x + w * 0.3;
  return wobble(along([[sx, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y], [sx + 0.8, y]]), 0.5, seed);
}

/**
 * Runs one step inside the managed browser (Playwright page and the app frame).
 * `body` is the source of an async function (ctx) where ctx has page, frame and helpers.
 */
let n = 0;
async function step(name, body) {
  n += 1;
  const file = path.join(HERE, `board-step-${n}.mjs`);
  writeFileSync(
    file,
    `const NAME = ${JSON.stringify(name)};
export default async function ({ page, frame }) {
  // Offset of the app frame inside the page (0 when the app is the page itself).
  let ox = 0, oy = 0;
  const fe = await frame.frameElement().catch(() => null);
  if (fe) { const b = await fe.boundingBox(); if (b) { ox = b.x; oy = b.y; } }
  const client = (pts) => frame.evaluate((p) => p.map(([x, y]) => window.__board.toClient(x, y)), pts);
  const stroke = async (pts) => {
    const px = await client(pts);
    await page.mouse.move(px[0][0] + ox, px[0][1] + oy);
    await page.mouse.down();
    for (const [x, y] of px.slice(1)) await page.mouse.move(x + ox, y + oy);
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  const tap = async (x, y) => stroke([[x, y]]);
  const say = async (text) => {
    await frame.fill('[data-test="voice-input"]', text);
    await frame.press('[data-test="voice-input"]', 'Enter');
    await page.waitForTimeout(150);
  };
  const board = () => frame.evaluate(() => JSON.parse(JSON.stringify(window.__board.store.board)));
  const status = () => frame.evaluate(() => document.querySelector('[data-test="status"]')?.textContent ?? '');
  // A crisp render of the board itself (the managed browser window is small).
  const hires = async () => {
    const url = await frame.evaluate(() => window.__board?.snapshot(20) ?? '');
    if (!url || !process.env.EMU_SHOTS) return;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.EMU_SHOTS + '/' + NAME + '-board.png', Buffer.from(url.split(',')[1], 'base64'));
  };
  try {
    ${body}
  } finally {
    await hires().catch(() => {});
  }
}
`,
  );
  const res = await iwsdk('browser', 'run', path.relative(process.cwd(), file), '--timeout', '100000');
  const out = res?.data?.result ?? res?.result ?? res;
  console.log(`${name}: ${JSON.stringify(out).slice(0, 400)}`);
  await sleep(400);
  await screenshot(name);
  return out;
}

const fail = (msg, extra) => {
  console.error(msg, extra ? JSON.stringify(extra).slice(0, 2000) : '');
  process.exit(1);
};

await waitReady();
await sleep(2000);

// 1. Open the sandbox (client-side navigation keeps the managed page) and draw a rough box.
const box1 = roughBox(6, 9, 11, 6, 3);
let r = await step(
  'board-01-box',
  `await frame.evaluate(() => { history.pushState(null, '', '/dev/board'); dispatchEvent(new PopStateEvent('popstate')); });
  await frame.waitForFunction(() => !!window.__board, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await stroke(${JSON.stringify(box1)});
  const b = await board();
  return { items: b.items.map((i) => [i.kind, i.type, i.x, i.y, i.w, i.h]), focus: b.focus, status: await status() };`,
);
if (!r?.items?.length || r.items[0][1] !== 'service') fail('the rough box did not become a service card', r);

// 2. A second rough box.
const box2 = roughBox(30, 8, 12, 7, 5);
r = await step(
  'board-02-two-boxes',
  `await stroke(${JSON.stringify(box2)});
  const b = await board();
  return { items: b.items.map((i) => [i.kind, i.type, i.x, i.y, i.w, i.h]), status: await status() };`,
);
if (r?.items?.filter((i) => i[0] === 'component').length !== 2) fail('the second box did not become a card', r);

// 3. A line from the first box's right edge to the second box: a connection.
r = await step(
  'board-03-connected',
  `const [a, c] = (await board()).items;
  const from = [a.x + a.w - 0.3, a.y + a.h / 2];
  const to = [c.x + 1.5, c.y + c.h / 2 + 0.4];
  const pts = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40; pts.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t + 0.25 * Math.sin(t * 6)]); }
  await stroke(pts);
  const b = await board();
  return { edges: b.edges, status: await status() };`,
);
if (r?.edges?.length !== 1) fail('the line did not connect the boxes', r);

// 4. Select the first box and label it by voice ("call that ..." labels at once); "that's the ..." on the second
//    box only suggests the label as a ghost.
r = await step(
  'board-04-suggested',
  `const [a, c] = (await board()).items;
  await tap(a.x + a.w / 2, a.y + a.h / 2);
  await say('call that the shortener service');
  await tap(c.x + c.w / 2, c.y + c.h / 2);
  await say("that's the URL store");
  const b = await board();
  return { labels: b.items.map((i) => i.label), ghosts: b.ghosts.map((g) => [g.op, g.args.text]), status: await status() };`,
);
if (r?.labels?.[0] !== 'Shortener service') fail('the voice label did not land on the first box', r);
if (r?.labels?.[1] !== null) fail('a statement must not label at once', r);

// 4b. Click the suggestion to keep it (it would also settle by itself after 4 s).
r = await step(
  'board-04-labelled',
  `const b0 = await board();
  const g = b0.ghosts[0];
  if (g) {
    const rect = await frame.evaluate((id) => window.__board.ghostRect(id), g.op_id);
    if (rect) await tap(rect.x + rect.w / 2, rect.y + rect.h / 2);
  }
  const b = await board();
  return { labels: b.items.map((i) => i.label), ghosts: b.ghosts.length, status: await status() };`,
);
if (r?.labels?.[1] !== 'URL store' || r?.ghosts !== 0) fail('accepting the suggestion did not label the second box', r);

// 5. Pull a cache card from the tray, connect the service to it with its tab, draw a client circle and a note.
r = await step(
  'board-05-tray-and-tab',
  `// The cache card is the 7th tray slot: x -12..-2, y 0.5 + 6 * 3.
  await stroke([[-7, 19.8], [0, 22], [14, 27], [21, 30]]);
  const items = (await board()).items;
  const svc = items[0];
  const cache = items[items.length - 1];
  await stroke([[svc.x + svc.w, svc.y], [svc.x + svc.w + 2, svc.y + 6], [cache.x + cache.w / 2, cache.y + cache.h / 2]]);
  const circle = [];
  for (let i = 0; i <= 64; i++) { const t = -Math.PI / 2 + (i / 60) * Math.PI * 2; circle.push([52 + 3.2 * Math.cos(t) + 0.15 * Math.sin(i), 28 + 3.2 * Math.sin(t)]); }
  await stroke(circle);
  await say('this is our mobile app');
  const note = [];
  for (let i = 0; i <= 30; i++) note.push([36 + i * 0.25, 34 + 0.6 * Math.sin(i * 0.9)]);
  await stroke(note);
  const b = await board();
  return { items: b.items.map((i) => [i.kind, i.type ?? i.recognized, i.label ?? null]), edges: b.edges.map((e) => [e.from, e.to, e.dir]), rev: b.rev, status: await status() };`,
);
const kinds = (r?.items ?? []).map((i) => i[1]);
if (!kinds.includes('cache') || !kinds.includes('client') || (r?.edges?.length ?? 0) < 2) fail('tray card, tab connection or circle did not work', r);

const final = await step('board-06-final', `return await board();`);
writeFileSync(path.join(SHOTS, 'board.json'), JSON.stringify(final, null, 2));
console.log('board ok');
