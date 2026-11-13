// What the controller round runs share (round-controllers.mjs, round-switch.mjs): placing the desk with a
// controller, strokes on the sheet by touch and by ray, the round bar and the cards by ray.

import { call, page, shot, sleep, stage, until, fail, look } from './round-lib.mjs';
import { below, glide, hold, pull, stroke, trigger, xr } from './input-lib.mjs';

/** A trigger pull long enough to span a frame of the emulator's few frames a second. */
const PULL_S = 0.7;

const toWorld = (pts, h) => page((a) => globalThis.__round.room.debug.toWorld(a.pts, a.h), { pts, h });

export const inputState = () =>
  page(() => {
    const a = globalThis.__xrApp;
    return {
      active: a.activeInput(),
      controllers: a.controllers().map((c) => ({ hand: c.hand, tracked: c.tracked, pressed: c.pressed, busy: c.busy })),
      hands: a.hands().map((h) => ({ hand: h.hand, tracked: h.tracked })),
      placingFor: a.ui.placingFor,
      hints: a.ui.hint.history.map((h) => h.line),
    };
  });

export const pointers = () => page(() => globalThis.__round.room.debug.pointers());

/** Controllers in hand; the right one's tip touches the desk and its trigger places it. */
export async function placeWithController(S, shotName, { rest = true } = {}) {
  await call('xr', 'set-input-mode', { mode: 'controller' });
  await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -38, yaw: 0, roll: 0 } });
  await hold('left', { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, { x: S.head.x - 0.3, y: 0.9, z: S.head.z - 1.1 });
  await hold('right', { x: S.head.x + 0.3, y: 0.95, z: S.head.z - 0.1 }, { x: S.head.x + 0.3, y: 0.9, z: S.head.z - 1.1 });
  await until('the placement prompt for controllers', () => (globalThis.__xrApp.ui.placingFor === 'controllers' && globalThis.__xrApp.activeInput() === 'controllers' ? true : null), null, 60000, 1000);
  await sleep(800);
  stage('placing with controllers', await inputState());
  if (shotName) await shot(shotName);
  // A trigger pull at the prompt card (the usual way to "click" a card) places nothing.
  const card = await page(() => {
    const g = globalThis.__xrApp.ui.status.group;
    g.updateWorldMatrix(true, false);
    const e = g.matrixWorld.elements;
    return { x: e[12], y: e[13], z: e[14] };
  });
  await hold('right', { x: S.head.x + 0.2, y: S.head.y - 0.32, z: S.head.z - 0.1 }, card);
  await sleep(1200);
  const onCard = await page(() => globalThis.__xrApp.controllers().find((c) => c.hand === 'right')?.busy);
  await pull('right', 0.7);
  await sleep(800);
  const early = await page(() => globalThis.__xrApp.desk$.value);
  stage('trigger at the prompt card', { rayOnCard: onCard, placed: !!early });
  if (early) await fail('a trigger pull at the prompt card placed the desk', early);
  // The controller's tip (its front) rests on the desk, 5 mm above the desk top, pointing down at it: after a
  // moment the trigger places it (held still without the trigger it places too, a little later).
  const tip = { x: S.tip.x, y: S.tip.y - 0.003, z: S.tip.z };
  await hold('right', tip, below(tip));
  await sleep(500);
  await pull('right', 0.4);
  const desk = await until('the desk placement', () => globalThis.__xrApp.desk$.value, null, 120000, 700);
  if (rest) await hold('right', { x: S.head.x + 0.3, y: 0.9, z: S.head.z - 0.12 }, { x: S.head.x + 0.3, y: 0.85, z: S.head.z - 1.1 });
  return desk;
}

/** Where the controller is held to point at the sheet: above its near edge, toward the user. */
export async function rayStand() {
  const [p] = await toWorld([[36, 56]], 22);
  return p;
}

export async function aim(hand, from, [x, y]) {
  const [p] = await toWorld([[x, y]], 0);
  await hold(hand, from, p);
}

/** A stroke through board points (cm): `far` by ray from `from`, `near` with the tip 4 mm above the sheet. */
export async function strokeBoard(hand, points, mode, from = null) {
  const w = await toWorld(points, mode === 'far' ? 0 : 0.4);
  await stroke(hand, { from: mode === 'far' ? from : null, points: w });
  // Rest away from the sheet, pointing off it.
  if (mode === 'near') await hold(hand, { x: w.at(-1).x, y: w.at(-1).y + 0.1, z: w.at(-1).z + 0.1 }, { x: w.at(-1).x, y: w.at(-1).y + 0.3, z: w.at(-1).z - 0.5 });
}

/** A trigger tap on a board point by ray. */
export async function tapBoard(hand, [x, y], from) {
  const [p] = await toWorld([[x, y]], 0);
  await hold(hand, from, p);
  await sleep(900);
  await pull(hand, 0.2);
  await sleep(300);
}

/** Waits for a suggestion and accepts it with a trigger tap by ray. */
export async function acceptGhostByTrigger(S, waitRounds, shotName) {
  let ghost = null;
  for (let i = 0; i < waitRounds && !ghost; i++) {
    await sleep(1500);
    ghost = await page(() => {
      const d = globalThis.__round.room.debug;
      const g = d.store.board.ghosts[0];
      return g ? { op_id: g.op_id, op: g.op, rect: d.ghostRect(g.op_id) } : null;
    });
  }
  if (!ghost?.rect) return null;
  const accepted = () => page(() => globalThis.__round.room.debug.store.log.filter((e) => e.op.src === 'scribe' && e.accepted).length);
  const before = await accepted();
  await look(S, -52);
  const from = await rayStand();
  const c = [ghost.rect.x + ghost.rect.w / 2, ghost.rect.y + ghost.rect.h / 2];
  await aim('right', from, c);
  await sleep(1000);
  if (shotName) await shot(shotName);
  await pull('right', 0.2);
  await sleep(1500);
  const still = await page((id) => globalThis.__round.room.debug.store.board.ghosts.some((g) => g.op_id === id), ghost.op_id);
  const now = await accepted();
  stage('suggestion accepted with the trigger', { ghost, still, before, now });
  if (still || now <= before) await fail('the trigger did not accept the suggestion', { ghost, still, before, now });
  return ghost;
}

/** Every visible clickable thing on a panel: its label and world centre. */
export const clickables = (panel) =>
  page((p) => {
    const root = globalThis.__xrApp.ui.groups[p];
    const out = [];
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      const props = o.properties?.peek?.();
      if (!props?.onClick && !props?.onPointerDown) return;
      // UIKit hides a part with display none (its own objects are not what is drawn, so `visible` says nothing).
      let shown = root.visible;
      for (let q = o; q && q !== root; q = q.parent) if (q.properties?.peek?.().display === 'none') shown = false;
      if (!shown) return;
      let label = '';
      o.traverse((c) => {
        const t = c.properties?.peek?.().text;
        if (typeof t === 'string' && !label) label = t;
      });
      const e = o.matrixWorld.elements;
      out.push({ label, at: { x: e[12], y: e[13], z: e[14] } });
    });
    return out;
  }, panel);

async function barButton(re) {
  const list = await clickables('roundBar');
  const b = list.find((x) => re.test(x.label));
  if (!b) await fail(`no ${re} button on the round bar`, list);
  return b.at;
}
const overBar = (at) => ({ x: at.x + 0.02, y: at.y + 0.2, z: at.z + 0.14 });

/** Points the ray at a round bar button and pulls the trigger. */
export async function pressBar(hand, re, shotName = null) {
  const at = await barButton(re);
  await hold(hand, overBar(at), at);
  await sleep(1200);
  stage(`ray on ${re}`, await rayInfo(hand));
  if (shotName) await shot(shotName);
  await page((h) => {
    const a = globalThis.__xrApp;
    const x = a.world.input.xr;
    const L = (globalThis.__trace = []);
    globalThis.__traceOff?.();
    globalThis.__traceOff = a.onFrame(() => {
      const mp = x.multiPointers[h];
      const gp = x.gamepads[h];
      const src = x.getPrimaryInputSource(h);
      L.push([Math.round(performance.now()), src?.gamepad?.buttons[0]?.pressed ? 1 : 0, gp?.getSelecting() ? 1 : 0, gp?.getSelectStart() ? 1 : 0, gp?.getSelectEnd() ? 1 : 0, mp.activeKind, mp.pointerStates.get('ray'), [...mp.ray.pointer.getButtonsDown()].join(''), gp?.inputSource === src ? 1 : 0, mp.ray.pointer.getEnabled() ? 1 : 0, a.world.input.xr === x ? 1 : 0]);
      if (L.length > 300) L.shift();
    });
  }, hand);
  await trigger(hand, 1);
  await sleep(PULL_S * 1000);
  await trigger(hand, 0);
  await sleep(900);
  const trace = await page(() => {
    globalThis.__traceOff?.();
    const out = [];
    let prev = '';
    for (const r of globalThis.__trace) {
      const k = r.slice(1).join(',');
      if (k !== prev) out.push(r.join(' '));
      prev = k;
    }
    return out;
  });
  stage(`pulled on ${re}`, { trace, after: await rayInfo(hand) });
}

/** What the platform's pointers for a controller are on, and the panel actions seen so far. */
export const rayInfo = (hand) =>
  page((h) => {
    const a = globalThis.__xrApp;
    if (!globalThis.__acts) {
      globalThis.__acts = [];
      a.ui.onAction((x) => globalThis.__acts.push(x));
    }
    const mp = a.world.input.xr.multiPointers[h];
    const hit = (k) => {
      const i = mp[k].pointer.getIntersection();
      if (!i || i.object.isVoidObject) return null;
      let panel = null;
      for (let q = i.object; q; q = q.parent) if (q.name) panel ??= q.name;
      let label = '';
      i.object.traverse?.((c) => {
        const t = c.properties?.peek?.().text;
        if (typeof t === 'string' && !label) label = t;
      });
      return { panel, label, dist: Math.round(i.distance * 1000) / 1000, down: [...mp[k].pointer.getButtonsDown()] };
    };
    const c = a.controllers().find((x) => x.hand === h);
    return { active: mp.activeKind, ray: hit('ray'), touch: hit('touch'), states: { ray: mp.pointerStates.get('ray'), touch: mp.pointerStates.get('touch') }, busy: c?.busy, pressed: c?.pressed, acts: globalThis.__acts.slice(-4) };
  }, hand);

/** Holds the trigger on a round bar button (End needs a second). */
export async function holdBar(hand, re, seconds) {
  const at = await barButton(re);
  await hold(hand, overBar(at), at);
  await sleep(1200);
  await trigger(hand, 1);
  await sleep(seconds * 1000);
  await trigger(hand, 0);
  await sleep(400);
}

/** Points the ray at a button of a card (status, summary) from in front of the chest and pulls the trigger. */
export async function pressCard(hand, S, panel, re, shotName = null) {
  const list = await clickables(panel);
  const b = list.find((x) => re.test(x.label));
  if (!b) await fail(`no ${re} button on the ${panel} card`, list);
  // In front of the chest, to the left: clear of the round bar (a tip close to a panel is a touch, not a ray).
  const from = { x: S.head.x - 0.16, y: S.head.y - 0.28, z: S.head.z - 0.02 };
  await hold(hand, from, b.at);
  await sleep(1200);
  if (shotName) await shot(shotName);
  await pull(hand, PULL_S);
  await sleep(400);
}

export { below, glide };

/** A fingertip press on a round bar button: in along the panel's normal, `holdS` on it, back out. */
export async function pokeBar(re, holdS = 0.5) {
  const b = await page((src) => {
    const root = globalThis.__xrApp.ui.groups.roundBar;
    root.updateWorldMatrix(true, true);
    const rx = new RegExp(src);
    let out = null;
    root.traverse((o) => {
      if (!o.properties?.peek?.().onPointerDown) return;
      let label = '';
      o.traverse((c) => {
        const t = c.properties?.peek?.().text;
        if (typeof t === 'string' && !label) label = t;
      });
      if (!rx.test(label)) return;
      const e = o.matrixWorld.elements;
      const m = root.matrixWorld.elements;
      out = { at: { x: e[12], y: e[13], z: e[14] }, n: { x: m[8], y: m[9], z: m[10] } };
    });
    return out;
  }, re.source);
  if (!b) await fail(`no ${re} button on the round bar`);
  const off = (d) => ({ x: b.at.x + b.n.x * d, y: b.at.y + b.n.y * d, z: b.at.z + b.n.z * d });
  const steps = [
    { label: 'above', position: off(0.07), anchor: 'index-tip', duration: 0.7, poseId: 'point' },
    { label: 'press', position: off(0.002), anchor: 'index-tip', duration: 0.6 },
    { label: 'hold', duration: holdS },
    { label: 'back', position: off(0.09), anchor: 'index-tip', duration: 0.6 },
  ];
  await xr('run-sequence', { device: 'hand-right', steps, body: 'fixed', gaze: 'fixed', idleHand: 'keep' });
  await sleep(700);
}
