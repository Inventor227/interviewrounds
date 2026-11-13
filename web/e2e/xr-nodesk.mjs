// Emulator run for the no-desk path: enter passthrough holding controllers (the hands hint shows), switch to hands,
// sit in open floor and never touch anything. After 6 s the desk falls back to 0.45 m below the head with a full
// virtual desk and the line "No desk? We set one up for you."

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'xr-lib.mjs'), path.join(here, 'xr-lib.mjs'));
const { go, page, startPlacement, stats, waitApp } = await import('./xr-lib.mjs');

const ROOM = process.env.EMU_ROOM ?? 'home_office';
// Open floor in the middle of the room, facing the window wall, nothing within reach.
const HEAD = { x: 0.1, y: 1.2, z: 0.2 };
const log = {};
const shot = async (name) => {
  await screenshot(name);
  log[name] = await stats().catch((e) => ({ error: String(e).slice(0, 200) }));
  console.log(name, JSON.stringify(log[name]));
};

await waitReady();
// No fallback override: the real 6 s timer runs.
await go('/session/emu?offer=1&standins=1&seats=1');
await waitApp();
await enterXR();
await startPlacement();
await call('xr', 'set-input-mode', { mode: 'controller' });
await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: -20, yaw: 0, roll: 0 } });
await sleep(1500);
await shot(`nodesk-1-controllers-hint`);
log.hintsAfterEnter = await page(() => globalThis.__xrApp.ui.hint.history);

await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'hand-left', position: { x: HEAD.x - 0.3, y: 0.9, z: HEAD.z - 0.1 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: HEAD.x + 0.3, y: 0.9, z: HEAD.z - 0.1 }, orientation: 'auto' });

let desk = null;
for (let i = 0; i < 40 && !desk; i++) {
  await sleep(1000);
  desk = await page(() => globalThis.__xrApp.desk$.value).catch(() => null);
}
log.desk = desk;
log.headAtPlacement = desk?.head ?? null;
log.hints = await page(() => globalThis.__xrApp.ui.hint.history).catch(() => null);
console.log('desk', JSON.stringify(desk));
await sleep(800);
await shot(`nodesk-2-fallback`);

await call('xr', 'set-transform', { device: 'headset', position: HEAD, orientation: { pitch: -12, yaw: 0, roll: 0 } });
// Hints last 6 to 7 s, shorter than one software-rendered screenshot: show each again, longer, just for its shot.
for (const [i, h] of (log.hints ?? []).entries()) {
  await page((line) => {
    const app = globalThis.__xrApp;
    app.ui.layoutHint(app.headPose());
    app.ui.showHint(line, performance.now(), 120000);
  }, h.line);
  await sleep(1000);
  await shot(`nodesk-3-hint-${i + 1}`);
}
await page(() => globalThis.__xrApp.ui.hint.show('', performance.now(), 0));
await sleep(1200);
await shot(`nodesk-4-room`);
const logs = await iwsdk('browser', 'logs', '--input-json', JSON.stringify({ count: 300 })).catch(() => null);
log.frameRateLog = JSON.stringify(logs ?? '').match(/\[xr\] frame rate[^"\\]*/g) ?? [];

writeFileSync(path.join(process.env.EMU_SHOTS, `nodesk-renderer-info.json`), JSON.stringify(log, null, 2));
const ok = desk && desk.source === 'fallback' && desk.head && Math.abs(desk.deskY - (desk.head.y - 0.45)) < 1e-6;
if (!ok) {
  console.error('expected the head-height fallback, got', JSON.stringify(desk));
  process.exit(1);
}
console.log(`no-desk fallback ok: deskY ${desk.deskY.toFixed(3)} = head ${desk.head.y.toFixed(3)} - 0.45`);
