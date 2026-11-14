// Emulator check for a hand's poke on the round bar in the room alone: a fingertip presses Pause, Mute and CC, and
// holds End until its ring is full. Each press is traced frame by frame (the platform's touch pointer state).
//   Emulator run (see README.md): allow up to 20 minutes.

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['xr-lib.mjs', 'input-lib.mjs']) copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', f), path.join(here, f));
const { go, page, startPlacement, waitApp, SAMPLE_ROUND } = await import('./xr-lib.mjs');
const { xr } = await import('./input-lib.mjs');

const HEAD = { x: 0.0, y: 1.2, z: -1.5 };
const TIP = { x: 0.04, y: 0.748, z: -1.74 };
const log = { checks: [], traces: {} };
let failed = 0;
const check = (name, ok, detail = null) => {
  log.checks.push({ name, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail === null ? '' : JSON.stringify(detail).slice(0, 600)}`);
  writeFileSync(path.join(process.env.EMU_SHOTS, 'xr-poke.json'), JSON.stringify(log, null, 2));
};

await waitReady();
await go('/session/emu?offer=1&standins=1&seats=1&fallback=600');
await waitApp();
await screenshot('p00-page').catch(() => undefined);
await enterXR();
await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: -45, yaw: 0, roll: 0 } });
await call('xr', 'set-transform', { device: 'hand-left', position: { x: HEAD.x - 0.3, y: 0.95, z: HEAD.z - 0.1 }, orientation: 'auto' });
await startPlacement();
await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'point' });
await call('xr', 'set-transform', { device: 'hand-right', position: TIP, anchor: 'index-tip', orientation: { fingers: [0, -0.85, -0.5], thumb: 'left' } });
let desk = null;
for (let i = 0; i < 40 && !desk; i++) {
  await sleep(800);
  desk = await page(() => globalThis.__xrApp.desk$.value);
}
check('desk placed by a fingertip', !!desk && desk.source === 'touch' && desk.input === 'hands', desk);
await page((s) => {
  globalThis.__acts = [];
  globalThis.__xrApp.ui.onAction((a) => globalThis.__acts.push(a));
  globalThis.__xrApp.ui.setRoundState(s);
}, SAMPLE_ROUND);
await sleep(800);

const button = (re) =>
  page((src) => {
    const a = globalThis.__xrApp;
    const root = a.ui.groups.roundBar;
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
      // The panel's front (its local +Z) in world space.
      out = { at: { x: e[12], y: e[13], z: e[14] }, n: { x: m[8], y: m[9], z: m[10] } };
    });
    return out;
  }, re.source);

const trace = (on) =>
  page((start) => {
    const a = globalThis.__xrApp;
    if (start) {
      const L = (globalThis.__trace = []);
      globalThis.__traceOff?.();
      globalThis.__traceOff = a.onFrame(() => {
        const mp = a.world.input.xr.multiPointers.right;
        const i = mp.touch.pointer.getIntersection();
        let hit = null;
        if (i && !i.object.isVoidObject) {
          let panel = null;
          for (let q = i.object; q; q = q.parent) if (q.name) panel ??= q.name;
          let label = '';
          i.object.traverse?.((c) => {
            const t = c.properties?.peek?.().text;
            if (typeof t === 'string' && !label) label = t;
          });
          hit = `${Math.round(i.distance * 1000)}mm ${panel}/${i.object.constructor.name}/${label}/${i.object.properties?.peek?.().onPointerDown ? 'btn' : '-'}/x${Math.round(a.world.player.indexTipSpaces.right.position.x * 1000)}`;
        }
        const tip = a.world.player.indexTipSpaces.right.position;
        L.push([mp.activeKind, mp.pointerStates.get('touch'), hit, [...mp.touch.pointer.getButtonsDown()].join(''), Math.round(tip.y * 1000), Math.round(tip.z * 1000), a.hands()[1].tracked ? 1 : 0].join(' '));
      });
      return null;
    }
    globalThis.__traceOff?.();
    const out = [];
    let prev = '';
    for (const r of globalThis.__trace) {
      if (r !== prev) out.push(r);
      prev = r;
    }
    return out.slice(-40);
  }, on);

/** A fingertip press on a button: in along the panel's normal, `holdS` on it, back out. */
async function poke(re, holdS, shot = null) {
  const b = await button(re);
  const off = (d) => ({ x: b.at.x + b.n.x * d, y: b.at.y + b.n.y * d, z: b.at.z + b.n.z * d });
  await trace(true);
  const steps = [
    { label: 'above', position: off(0.07), anchor: 'index-tip', duration: 0.7, poseId: 'point' },
    { label: 'press', position: off(0.002), anchor: 'index-tip', duration: 0.6 },
    { label: 'hold', duration: holdS },
    { label: 'back', position: off(0.09), anchor: 'index-tip', duration: 0.6 },
  ];
  const run = xr('run-sequence', { device: 'hand-right', steps, body: 'fixed', gaze: 'fixed', idleHand: 'keep' }).catch((e) => ({ error: String(e).slice(0, 600) }));
  if (shot) {
    await sleep(1500 + holdS * 400);
    await screenshot(shot).catch(() => undefined);
  }
  const res = await run;
  await sleep(900);
  const t = await trace(false);
  log.traces[re.source + (holdS > 1 ? '-hold' : '')] = { trace: t, error: res?.error ?? null };
  return page(() => globalThis.__acts.slice());
}

let acts = await poke(/Pause/, 0.5, 'p01-poke-on-pause');
check('a poke presses Pause', acts.includes('pause'), { acts, trace: log.traces.Pause });
acts = await poke(/Mute/, 0.5);
check('a poke presses Mute', acts.includes('mute'), acts);
acts = await poke(/CC/, 0.5);
check('a poke presses CC', acts.includes('captions'), acts);
// (A short poke on End doing nothing is unit tested: a scripted poke lasts over a second at the emulator's frame rate.)
acts = await poke(/End/, 2.2, 'p02-poke-holds-end');
check('a poke held on End ends', acts.includes('end'), { acts, trace: log.traces['End-hold'] });

writeFileSync(path.join(process.env.EMU_SHOTS, 'xr-poke.json'), JSON.stringify(log, null, 2));
if (failed) {
  console.error(`xr poke: ${failed} checks failed`);
  process.exit(1);
}
console.log('xr poke ok');
