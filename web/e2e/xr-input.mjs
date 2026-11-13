// Emulator run for hands and controllers in the room alone (no round): the placement prompt per input, the desk
// placed with a controller's tip (trigger, then the dwell), the controller model from this origin, every button of
// the round bar and of the status and summary cards pressed by ray, the sheet moved by its grab bar with a
// controller (touch and ray) and with a hand, and the change from controllers to hands and back.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/xr-input.mjs --timeout 30 --out plan/shots/t25/room

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['xr-lib.mjs', 'input-lib.mjs']) copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', f), path.join(here, f));
const { consoleLines, go, page, startPlacement, stats, waitApp, SAMPLE_ROUND, SAMPLE_SUMMARY } = await import('./xr-lib.mjs');
const { below, glide, hold, pull, rayPress, trigger, xr } = await import('./input-lib.mjs');

// home_office: desk top 0.74 m, near edge z -1.7.
const HEAD = { x: 0.0, y: 1.2, z: -1.5 };
const DESK_Y = 0.74;
const TOUCH = { x: 0.04, y: DESK_Y + 0.005, z: -1.74 };
const log = { checks: [], shots: {} };
let failed = 0;
const check = (name, ok, detail = null) => {
  log.checks.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail === null ? '' : JSON.stringify(detail).slice(0, 500)}`);
  // Kept on disk as the run goes (the emulator's browser can drop out before the end).
  writeFileSync(path.join(process.env.EMU_SHOTS, 'xr-input.json'), JSON.stringify(log, null, 2));
};
const shot = async (name) => {
  await screenshot(name);
  log.shots[name] = await stats().catch((e) => ({ error: String(e).slice(0, 200) }));
  console.log('shot', name, JSON.stringify(log.shots[name]));
};
const look = (pitch, yaw = 0) => call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch, yaw, roll: 0 } });
const app = (fn, arg = null) => page(fn, arg);
const input = () =>
  app(() => {
    const a = globalThis.__xrApp;
    return {
      active: a.activeInput(),
      controllers: a.controllers().map((c) => ({ hand: c.hand, tracked: c.tracked, pressed: c.pressed, busy: c.busy, tip: c.tip })),
      hands: a.hands().map((h) => ({ hand: h.hand, tracked: h.tracked })),
      views: ['left', 'right'].map((s) => a.scene.getObjectByName(`controller-view-${s}`)?.visible ?? null),
      models: ['left', 'right'].map((s) => !!a.world.input.xr.visualAdapters.controller[s].visual),
      standins: ['left', 'right'].map((s) => a.scene.getObjectByName(`controller-view-${s}`)?.getObjectByName('controller-standin')?.visible ?? null),
      placingFor: a.ui.placingFor,
      hints: a.ui.hint.history.map((h) => h.line),
      move: a.moveStatus(),
      pulses: a.hapticLog().map((p) => `${p.hand}:${p.name}`),
    };
  });
const desk = () => app(() => globalThis.__xrApp.desk$.value);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
/** World position of a named object, or of a UI button (a field of a panel object). */
const worldOf = (name) =>
  app((n) => {
    const a = globalThis.__xrApp;
    const o = a.scene.getObjectByName(n);
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements;
    return { x: e[12], y: e[13], z: e[14] };
  }, name);
/** Every visible clickable thing on a panel: its label and world centre. */
const clickables = (panel) =>
  app((p) => {
    const a = globalThis.__xrApp;
    const root = a.ui.groups[p];
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
const actions = () => app(() => globalThis.__acts.slice());
/** What the platform's pointer for the right controller is on: which kind is active and the panel under it. */
const rayInfo = () =>
  app(() => {
    const mp = globalThis.__xrApp.world.input.xr.multiPointers.right;
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
      return { panel, label, dist: Math.round(i.distance * 1000) / 1000 };
    };
    return { active: mp.activeKind, ray: hit('ray'), touch: hit('touch'), states: { ray: mp.pointerStates.get('ray'), touch: mp.pointerStates.get('touch') } };
  });

await waitReady();
await go('/session/emu?offer=1&standins=1&seats=1&fallback=600');
await waitApp();
await app(() => {
  // Room for the controller models in the resource timings (the dev server's modules fill the default buffer).
  performance.clearResourceTimings();
  performance.setResourceTimingBufferSize(2000);
});
// One capture of the page before the session (the emulator's room needs it to draw).
await screenshot('00-page').catch(() => undefined);
await enterXR();
await app(() => {
  globalThis.__acts = [];
  globalThis.__inputs = [];
  globalThis.__xrApp.ui.onAction((a) => globalThis.__acts.push(a));
  globalThis.__xrApp.onInputChange((a) => globalThis.__inputs.push(a));
});

// ---- controllers in hand: the prompt names the controller's action, and nothing says to put them down ----
await call('xr', 'set-input-mode', { mode: 'controller' });
await look(-38);
// Held level in front of the chest, in the band where a desk could be, perfectly still.
await hold('right', { x: 0.25, y: 0.82, z: -1.62 }, { x: 0.25, y: 0.84, z: -2.6 });
await hold('left', { x: -0.25, y: 0.82, z: -1.62 }, { x: -0.25, y: 0.84, z: -2.6 });
await startPlacement();
await sleep(3500);
let st = await input();
check('controllers are the active input', st.active === 'controllers', st);
check('both controllers tracked, no hands', st.controllers.every((c) => c.tracked) && st.hands.every((h) => !h.tracked));
check('the prompt is worded for controllers', st.placingFor === 'controllers', st.placingFor);
check('no hint about putting controllers down', st.hints.length === 0, st.hints);
check('controllers held still and level do not place a desk', (await desk()) === null);
check('the controller model comes up (no stand-in)', st.models.every(Boolean) && st.standins.every((s) => s === false), { models: st.models, standins: st.standins });
const glbs = await app(() => performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /\.glb/.test(n) && /input-profiles|jsdelivr/.test(n)));
check('controller models are loaded from this origin', glbs.length >= 2 && glbs.every((u) => new URL(u).pathname.startsWith('/vendor/input-profiles/') && !/jsdelivr/.test(u)), glbs);
await shot('01-prompt-controllers');

// ---- the desk: a trigger with the controller level places nothing; the tip resting on the desk, pointing down, does ----
await hold('right', TOUCH, { x: TOUCH.x, y: TOUCH.y - 0.02, z: TOUCH.z - 0.3 });
await sleep(1500);
await pull('right', 0.5);
await sleep(1200);
check('a trigger pull with the controller level does not place the desk', (await desk()) === null);
await hold('right', TOUCH, below(TOUCH));
await sleep(400);
await pull('right', 0.4);
let d = null;
for (let i = 0; i < 20 && !d; i++) {
  await sleep(700);
  d = await desk();
}
check('the tip resting on the desk, pointing down, places it', !!d && d.source === 'touch' && d.input === 'controllers' && d.hand === 'right', d);
check('the sheet lands on the desk top, not above it', !!d && near(d.deskY, DESK_Y, 0.002) && near(d.origin.x, TOUCH.x, 0.003) && near(d.origin.z, TOUCH.z, 0.003), d && { deskY: d.deskY, origin: d.origin });
await hold('right', { x: 0.3, y: 0.95, z: -1.6 }, { x: 0.3, y: 0.9, z: -2.6 });
await sleep(1500);
await shot('02-placed-with-controller');

// ---- the round bar by ray: Pause, Mute, CC, then End held ----
await app((s) => globalThis.__xrApp.ui.setRoundState(s), SAMPLE_ROUND);
await sleep(800);
await look(-48);
const bar = await clickables('roundBar');
check('the round bar has its four buttons', bar.length === 4, bar.map((b) => b.label));
const byLabel = (list, re) => list.find((b) => re.test(b.label));
const pauseBtn = byLabel(bar, /Pause/);
// The controller a little above and in front of the bar, pointing down at it.
const barFrom = { x: pauseBtn.at.x + 0.02, y: pauseBtn.at.y + 0.2, z: pauseBtn.at.z + 0.14 };
await hold('right', barFrom, pauseBtn.at);
await sleep(1200);
st = await input();
check('the ray is on the Pause button (the platform ray and cursor show)', st.controllers[1].busy === true, st.controllers[1]);
await shot('03-ray-on-pause');
await pull('right', 0.25);
await sleep(600);
check('the trigger pressed Pause', (await actions()).includes('pause'), await actions());
for (const re of [/Mute/, /CC/]) await rayPress('right', barFrom, byLabel(bar, re).at);
let acts = await actions();
check('Mute and CC pressed by ray', acts.includes('mute') && acts.includes('captions'), acts);
const endBtn = byLabel(bar, /End/);
await hold('right', barFrom, endBtn.at);
await sleep(900);
// (A short pull on End doing nothing is unit tested: the emulator's tooling cannot make a pull shorter than a second.)
check('End not pressed yet', !(await actions()).includes('end'));
await trigger('right', 1);
await sleep(700);
await shot('04-end-hold-ring');
await sleep(1200);
await trigger('right', 0);
await sleep(600);
acts = await actions();
check('End held for a second, then released, ends', acts.includes('end'), acts);
st = await input();
check('the controller pulsed on the presses', st.pulses.filter((p) => p === 'right:press').length >= 3, st.pulses);

// ---- the status and summary cards by ray ----
await app(() => globalThis.__xrApp.ui.setStatus('paused'));
await sleep(800);
await look(-30);
const statusBtns = await clickables('status');
check('the paused card has a Resume button', !!byLabel(statusBtns, /Resume/), statusBtns.map((b) => b.label));
// Held in front of the chest, to the left: well clear of the round bar (a tip within a few centimetres of a
// panel is a touch, and touch comes before the ray).
const cardFrom = { x: HEAD.x - 0.16, y: HEAD.y - 0.28, z: HEAD.z - 0.02 };
await hold('right', cardFrom, byLabel(statusBtns, /Resume/).at);
await sleep(1200);
log.rayOnResume = await rayInfo();
await shot('05-ray-on-resume');
await pull('right', 0.25);
await sleep(600);
check('Resume on the card pressed by ray', (await actions()).includes('resume'), await actions());
await app((s) => {
  const ui = globalThis.__xrApp.ui;
  ui.hideStatus();
  ui.showSummary(s);
}, SAMPLE_SUMMARY);
await sleep(1200);
const sumBtns = await clickables('summary');
check('the summary card has Retry and See full report', !!byLabel(sumBtns, /Retry/) && !!byLabel(sumBtns, /report/i), sumBtns.map((b) => b.label));
await hold('right', cardFrom, byLabel(sumBtns, /Retry/).at);
await sleep(1200);
log.rayOnRetry = await rayInfo();
await shot('06-ray-on-summary');
await pull('right', 0.25);
await sleep(500);
await rayPress('right', cardFrom, byLabel(sumBtns, /report/i).at);
acts = await actions();
check('both summary buttons pressed by ray', acts.includes('retry') && acts.includes('report'), acts);
await app(() => globalThis.__xrApp.ui.hideSummary());

// ---- the grab bar: trigger and hold with the tip on it, carry, let go ----
await look(-52);
let grab = await worldOf('sheet-move-bar');
check('the grab bar is below the sheet', !!grab && grab.y > DESK_Y && grab.y < DESK_Y + 0.03, grab);
let before = await desk();
let tip = { x: grab.x, y: grab.y + 0.006, z: grab.z };
await hold('right', tip, below(tip));
await sleep(900);
await shot('07-grab-bar');
await trigger('right', 1);
await sleep(1600);
st = await input();
check('held for half a second the sheet lifts', st.move.state === 'moving', st.move);
await glide('right', { x: tip.x + 0.1, y: tip.y, z: tip.z - 0.06 }, below({ x: tip.x + 0.1, y: tip.y, z: tip.z - 0.06 }), 0.8);
await sleep(600);
await shot('08-carrying');
await trigger('right', 0);
await sleep(1200);
let after = await desk();
check('letting go sets the desk where it was carried', near(after.origin.x - before.origin.x, 0.1, 0.01) && near(after.origin.z - before.origin.z, -0.06, 0.01) && near(after.deskY, before.deskY, 0.004), { dx: after.origin.x - before.origin.x, dz: after.origin.z - before.origin.z, dy: after.deskY - before.deskY });
// A quick pull on the bar moves nothing.
grab = await worldOf('sheet-move-bar');
tip = { x: grab.x, y: grab.y + 0.006, z: grab.z };
await hold('right', tip, below(tip));
await sleep(700);
await pull('right', 0.15);
await sleep(600);
check('a quick pull on the bar moves nothing', near((await desk()).origin.x, after.origin.x, 1e-6));
// By ray from a distance: hold the trigger on the bar, then move the controller.
before = await desk();
const rayFrom = { x: grab.x + 0.05, y: grab.y + 0.24, z: grab.z + 0.2 };
await hold('right', rayFrom, grab);
await sleep(900);
await trigger('right', 1);
await sleep(1600);
st = await input();
check('the ray on the bar, held, lifts the sheet too', st.move.state === 'moving', st.move);
await glide('right', { x: rayFrom.x - 0.1, y: rayFrom.y, z: rayFrom.z + 0.06 }, { x: grab.x - 0.1, y: grab.y, z: grab.z + 0.06 }, 0.8);
await sleep(600);
await trigger('right', 0);
await sleep(1200);
after = await desk();
check('carried back by ray', near(after.origin.x - before.origin.x, -0.1, 0.012) && near(after.origin.z - before.origin.z, 0.06, 0.012), { dx: after.origin.x - before.origin.x, dz: after.origin.z - before.origin.z });
await shot('09-moved-back');

// ---- the controllers go down: hands take over with no prompt ----
await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'hand-left', position: { x: HEAD.x - 0.3, y: 0.95, z: HEAD.z - 0.1 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: HEAD.x + 0.3, y: 0.95, z: HEAD.z - 0.1 }, orientation: 'auto' });
await sleep(2000);
st = await input();
check('hands are the active input after the controllers go down', st.active === 'hands' && st.hands.some((h) => h.tracked) && st.controllers.every((c) => !c.tracked), st);
check('the controller tip dots and bodies are gone', st.views.every((v) => v === false), st.views);
check('still no hint', st.hints.length === 0, st.hints);
await shot('10-hands');
// A hand moves the sheet the same way: pinch and hold on the bar, carry, let go.
grab = await worldOf('sheet-move-bar');
before = await desk();
const g0 = { x: grab.x, y: grab.y + 0.012, z: grab.z };
await xr('run-sequence', {
  device: 'hand-right',
  steps: [
    { label: 'reach', position: g0, anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: 0.3 },
    { label: 'pinch', pinch: 1, duration: 0.15 },
    { label: 'hold', duration: 1.6 },
    { label: 'carry', position: { x: g0.x + 0.08, y: g0.y, z: g0.z }, duration: 0.8 },
    { label: 'hold end', duration: 0.5 },
    { label: 'release', pinch: 0, duration: 0.15 },
    { label: 'lift', position: { x: g0.x + 0.08, y: g0.y + 0.08, z: g0.z }, duration: 0.3 },
  ],
  body: 'auto',
  gaze: 'fixed',
  idleHand: 'keep',
});
await sleep(1200);
after = await desk();
check('a pinch and hold on the bar carries the sheet with a hand', near(after.origin.x - before.origin.x, 0.08, 0.02), { dx: after.origin.x - before.origin.x, dz: after.origin.z - before.origin.z });
await shot('11-moved-by-hand');
// A hand pokes the round bar (direct touch), as before.
await app((s) => globalThis.__xrApp.ui.setRoundState(s), SAMPLE_ROUND);
await sleep(600);
const bar2 = await clickables('roundBar');
const cc = byLabel(bar2, /CC/).at;
const n0 = (await actions()).filter((a) => a === 'captions').length;
await xr('run-sequence', {
  device: 'hand-right',
  steps: [
    { label: 'above', position: { x: cc.x, y: cc.y + 0.05, z: cc.z + 0.035 }, anchor: 'index-tip', duration: 0.6, poseId: 'point' },
    { label: 'press', position: { x: cc.x, y: cc.y - 0.006, z: cc.z - 0.004 }, anchor: 'index-tip', duration: 0.35 },
    { label: 'hold', duration: 0.2 },
    { label: 'back', position: { x: cc.x, y: cc.y + 0.05, z: cc.z + 0.035 }, anchor: 'index-tip', duration: 0.35 },
  ],
  body: 'auto',
  gaze: 'fixed',
  idleHand: 'keep',
}).catch((e) => console.log('poke sequence failed', String(e).slice(0, 400)));
await sleep(800);
const poked = (await actions()).filter((a) => a === 'captions').length > n0;
log.handPoke = poked;
console.log(`info hand poke on CC ${poked ? 'pressed' : 'did not press'} (direct touch in the emulator)`);

// ---- and back to controllers: placed again by holding the tip still on the desk (the dwell), pointing down ----
await call('xr', 'set-input-mode', { mode: 'controller' });
await hold('left', { x: -0.25, y: 0.95, z: -1.6 }, { x: -0.25, y: 0.9, z: -2.6 });
await hold('right', { x: 0.3, y: 0.95, z: -1.6 }, { x: 0.3, y: 0.9, z: -2.6 });
await sleep(1500);
st = await input();
check('controllers picked up again are the active input', st.active === 'controllers', st.active);
// (The emulator may already hold controllers when the session starts, before this script listens.)
check('input changes were reported', (await app(() => globalThis.__inputs)).slice(-2).join(',') === 'hands,controllers', await app(() => globalThis.__inputs));
await app(() => void globalThis.__xrApp.replace().catch(() => {}));
await sleep(1200);
check('placing again: the prompt is for controllers', (await input()).placingFor === 'controllers');
const T2 = { x: -0.1, y: DESK_Y + 0.005, z: -1.78 };
await hold('left', T2, below(T2));
d = null;
for (let i = 0; i < 25 && !(d && d.hand === 'left'); i++) {
  await sleep(700);
  d = await desk();
}
check('the tip held still on the desk places it without the trigger', !!d && d.source === 'touch' && d.input === 'controllers' && d.hand === 'left' && near(d.deskY, DESK_Y, 0.002), d);
await hold('left', { x: -0.25, y: 0.95, z: -1.6 }, { x: -0.25, y: 0.9, z: -2.6 });
await sleep(1500);
await shot('12-placed-by-dwell');

log.final = await input();
log.console = (await consoleLines(200)).filter((l) => /^\[(error|warn)\]/.test(l) && !/▀|▄|██/.test(l)).slice(-40);
console.log('console', JSON.stringify(log.console));
writeFileSync(path.join(process.env.EMU_SHOTS, 'xr-input.json'), JSON.stringify(log, null, 2));
if (failed) {
  console.error(`xr input: ${failed} checks failed`);
  process.exit(1);
}
console.log('xr input ok');
