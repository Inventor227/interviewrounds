import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, screenshot, sleep, waitReady } from './emu-lib.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['xr-lib.mjs', 'input-lib.mjs']) copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', f), path.join(here, f));
const { go, page, startPlacement, waitApp, SAMPLE_ROUND } = await import('./xr-lib.mjs');
const { hold, pull, trigger, xr } = await import('./input-lib.mjs');
const HEAD = { x: 0.0, y: 1.2, z: -1.5 };
const TOUCH = { x: 0.04, y: 0.745, z: -1.74 };
await waitReady();
await go('/session/emu?offer=1&standins=1&seats=1&fallback=600');
await waitApp();
await screenshot('d00-page').catch(() => {});
await enterXR();
await call('xr', 'set-input-mode', { mode: 'controller' });
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: -48, yaw: 0, roll: 0 } });
await startPlacement();
await hold('right', TOUCH, { x: TOUCH.x, y: TOUCH.y - 0.02, z: TOUCH.z - 0.3 });
await sleep(1500);
await pull('right', 0.5);
for (let i = 0; i < 20; i++) { await sleep(700); if (await page(() => !!globalThis.__xrApp.desk$.value)) break; }
await page((s) => { globalThis.__acts = []; globalThis.__xrApp.ui.onAction((a) => globalThis.__acts.push(a)); globalThis.__xrApp.ui.setRoundState(s); }, SAMPLE_ROUND);
await sleep(800);
const at = await page(() => { const b = globalThis.__xrApp.ui.roundBar.pause.root; b.updateWorldMatrix(true, false); const e = b.matrixWorld.elements; return { x: e[12], y: e[13], z: e[14] }; });
await hold('right', { x: at.x + 0.02, y: at.y + 0.2, z: at.z + 0.14 }, at);
await sleep(1200);
await page(() => {
  const a = globalThis.__xrApp; const x = a.world.input.xr; const L = (globalThis.__dbg = []);
  let lastGp = null, lastSrc = null;
  a.onFrame(() => {
    const mp = x.multiPointers.right; const gp = x.gamepads.right; const src = x.getPrimaryInputSource('right');
    L.push({ t: Math.round(performance.now()), raw: src?.gamepad?.buttons[0]?.pressed, val: src?.gamepad?.buttons[0]?.value, sel: gp?.getSelecting(), st: gp?.getSelectStart(), en: gp?.getSelectEnd(), fs: { ...x.getSelectState('right') }, active: mp.activeKind, ray: mp.pointerStates.get('ray'), touch: mp.pointerStates.get('touch'), newGp: gp !== lastGp, newSrc: src !== lastSrc, down: [...mp.ray.pointer.getButtonsDown()], hit: mp.ray.pointer.getIntersection()?.object?.constructor?.name, cap: !!mp.ray.pointer.getPointerCapture() });
    lastGp = gp; lastSrc = src;
    if (L.length > 400) L.shift();
  });
});
await sleep(1000);
for (const secs of [0.3, 0.5, 1.9]) {
  await page(() => { globalThis.__dbg.push({ mark: 'pull' }); });
  await trigger('right', 1); await sleep(secs * 1000); await trigger('right', 0); await sleep(1200);
}
await page(() => { globalThis.__dbg.push({ mark: 'xr select' }); });
await xr('select', { device: 'controller-right', duration: 0.5 });
await sleep(1200);
const d = await page(() => ({ acts: globalThis.__acts, dbg: globalThis.__dbg }));
console.log('ACTS', JSON.stringify(d.acts));
for (const l of d.dbg) console.log(JSON.stringify(l));
