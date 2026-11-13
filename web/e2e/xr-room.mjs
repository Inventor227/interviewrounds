// Emulator run for the XR room: enter passthrough, sit at the room's desk or table, rest the right index tip on it,
// then screenshot placement, the seated room with round chrome, scoring and the summary. Logs render stats.
// Rooms: home_office (1 seat, desk against the window wall) and conference_room (3 seats, near end of the table).
//   plan/ops-tools/emu.sh <worktree> web/e2e/xr-room.mjs --room home_office --size 800x800 --out plan/shots/xr/home_office
// Needs e2e/xr-lib.mjs next to it (copied by the script itself into .emu/).

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// emu.sh uploads only this file; the lib lives next to it in the repo.
const libSrc = path.join(process.env.EMU_APP_DIR, 'e2e', 'xr-lib.mjs');
copyFileSync(libSrc, path.join(here, 'xr-lib.mjs'));
const { go, page, stats, waitApp, SAMPLE_ROUND, SAMPLE_SUMMARY } = await import('./xr-lib.mjs');

const ROOM = process.env.EMU_ROOM ?? 'home_office';
const SETUPS = {
  // Desk top 0.74 m, near edge z -1.7, against the back wall.
  home_office: { seats: 1, head: { x: 0.0, y: 1.2, z: -1.48 }, tip: { x: 0.04, y: 0.748, z: -1.74 } },
  // Table top 0.74 m, near end z -1.0, centred on x = 0.
  conference_room: { seats: 3, head: { x: 0.0, y: 1.2, z: -0.72 }, tip: { x: 0.02, y: 0.748, z: -1.06 } },
};
const S = SETUPS[ROOM] ?? SETUPS.home_office;
const log = {};
const shot = async (name) => {
  await screenshot(name);
  log[name] = await stats().catch((e) => ({ error: String(e).slice(0, 200) }));
  console.log(name, JSON.stringify(log[name]));
};

await waitReady();
await go(`/session/emu?offer=1&standins=1&fallback=120&seats=${S.seats}`);
await waitApp();
await enterXR();
await sleep(1500);

await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -38, yaw: 0, roll: 0 } });
// Park the hands low and to the sides while the prompt shows.
await call('xr', 'set-transform', { device: 'hand-left', position: { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.3, y: 0.95, z: S.head.z - 0.1 }, orientation: 'auto' });
await sleep(1500);
await shot(`${ROOM}-1-prompt`);

// Rest the right index tip on the desk, finger pointing down.
await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'point' });
await call('xr', 'set-transform', {
  device: 'hand-right',
  position: S.tip,
  anchor: 'index-tip',
  orientation: { fingers: [0, -0.85, -0.5], thumb: 'left' },
});
// The dwell needs 0.6 s of frames; software rendering is slow, so allow plenty.
let desk = null;
for (let i = 0; i < 20 && !desk; i++) {
  await sleep(1000);
  desk = await page(() => globalThis.__xrApp.desk$.value).catch(() => null);
}
log.desk = desk;
console.log('desk', JSON.stringify(desk));
if (!desk || desk.source !== 'touch') {
  console.error('placement did not come from the touch:', JSON.stringify(desk));
}
await sleep(1200);
await shot(`${ROOM}-2-placed`);

// Move the hand off the sheet and look across at the panel.
await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.28, y: 0.8, z: S.head.z - 0.2 }, orientation: 'auto' });
await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'default' });
await page((st) => {
  const app = globalThis.__xrApp;
  app.ui.setRoundState(st);
  app.ui.setCaption('Daniel', 'Good. Walk me through what happens when a user opens a short link for the first time.');
}, SAMPLE_ROUND);
await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -16, yaw: 0, roll: 0 } });
await sleep(1500);
await shot(`${ROOM}-3-room`);

await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -48, yaw: -8, roll: 0 } });
await sleep(1200);
await shot(`${ROOM}-4-chrome`);

await page(() => {
  const app = globalThis.__xrApp;
  app.ui.setRoundState({ status: 'scoring', elapsed_s: 900, total_s: 900, muted: false, captions: false, brief: null });
  app.ui.setStatus('scoring', 0.55);
});
await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -8, yaw: 0, roll: 0 } });
await sleep(1200);
await shot(`${ROOM}-5-scoring`);

await page((sum) => globalThis.__xrApp.ui.showSummary(sum), SAMPLE_SUMMARY);
await sleep(1200);
await shot(`${ROOM}-6-summary`);

log.seats = await page(() => globalThis.__xrApp.room.seatPoses());
writeFileSync(path.join(process.env.EMU_SHOTS, `${ROOM}-renderer-info.json`), JSON.stringify(log, null, 2));
if (!desk || desk.source !== 'touch') process.exit(1);
console.log('xr room ok');
