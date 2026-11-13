// What the controller round runs share (round-controllers.mjs, round-switch.mjs): placing the desk with a
// controller, strokes on the sheet by touch and by ray, the round bar and the cards by ray.

import { call, page, shot, sleep, stage, until, fail, look } from './round-lib.mjs';
import { below, glide, hold, pull, stroke, trigger } from './input-lib.mjs';

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
export async function placeWithController(S, shotName) {
  await call('xr', 'set-input-mode', { mode: 'controller' });
  await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -38, yaw: 0, roll: 0 } });
  await hold('left', { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, { x: S.head.x - 0.3, y: 0.9, z: S.head.z - 1.1 });
  await hold('right', { x: S.head.x + 0.3, y: 0.95, z: S.head.z - 0.1 }, { x: S.head.x + 0.3, y: 0.9, z: S.head.z - 1.1 });
  await until('the placement prompt for controllers', () => (globalThis.__xrApp.ui.placingFor === 'controllers' && globalThis.__xrApp.activeInput() === 'controllers' ? true : null), null, 60000, 1000);
  await sleep(800);
  stage('placing with controllers', await inputState());
  if (shotName) await shot(shotName);
  // The controller's tip (its front) rests on the desk: 5 mm above the desk top, pointing forward and a little down.
  const tip = { x: S.tip.x, y: S.tip.y - 0.003, z: S.tip.z };
  await hold('right', tip, { x: tip.x, y: tip.y - 0.03, z: tip.z - 0.3 });
  await sleep(1200);
  await pull('right', 0.25);
  const desk = await until('the desk placement', () => globalThis.__xrApp.desk$.value, null, 120000, 1000);
  await hold('right', { x: S.head.x + 0.3, y: 0.9, z: S.head.z - 0.12 }, { x: S.head.x + 0.3, y: 0.85, z: S.head.z - 1.1 });
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
  const busy = await page((h) => globalThis.__xrApp.controllers().find((c) => c.hand === h)?.busy, hand);
  stage(`ray on ${re}`, { busy });
  if (shotName) await shot(shotName);
  await pull(hand, 0.25);
  await sleep(400);
}

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
  await pull(hand, 0.25);
  await sleep(400);
}

export { below, glide };
