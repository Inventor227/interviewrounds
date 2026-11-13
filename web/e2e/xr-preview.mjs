// Emulator run for the 2D preview (no WebXR path): the room in the page, stage stretched to the viewport for the
// shot. Screens with 1 and 3 seats, live chrome and the summary; logs render stats.
//   plan/ops-tools/emu.sh <worktree> web/e2e/xr-preview.mjs --size 1280x720 --out plan/shots/xr/preview

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'xr-lib.mjs'), path.join(here, 'xr-lib.mjs'));
const { go, page, stats, waitApp, SAMPLE_ROUND, SAMPLE_SUMMARY } = await import('./xr-lib.mjs');

const log = {};
const shot = async (name) => {
  await screenshot(name);
  log[name] = await stats().catch((e) => ({ error: String(e).slice(0, 200) }));
  console.log(name, JSON.stringify(log[name]));
};
const fill = () =>
  page(() => {
    const s = document.createElement('style');
    s.textContent = '.xr-stage{position:fixed;inset:0;margin:0;border-radius:0;aspect-ratio:auto;width:100vw;height:100vh;z-index:50}';
    document.head.append(s);
    window.dispatchEvent(new Event('resize'));
  });

await waitReady();
await go('/session/emu?view=preview&seats=1');
await waitApp();
await fill();
await sleep(6000); // stand-ins load
log.mode = await page(() => globalThis.__xrApp.mode);
await shot('preview-1-seat');

await page((st) => {
  const app = globalThis.__xrApp;
  app.ui.setRoundState(st);
  app.ui.setCaption('Daniel', 'Good. Walk me through what happens when a user opens a short link for the first time.');
}, SAMPLE_ROUND);
await sleep(1500);
await shot('preview-1-seat-round');

await page(() => globalThis.__xrApp.setSeats(3));
await sleep(6000);
await shot('preview-3-seats-round');

await page((sum) => {
  const app = globalThis.__xrApp;
  app.ui.setRoundState({ status: 'scored', elapsed_s: 900, total_s: 900, muted: false, captions: false, brief: null });
  app.ui.showSummary(sum);
}, SAMPLE_SUMMARY);
await sleep(1500);
await shot('preview-3-seats-summary');

writeFileSync(path.join(process.env.EMU_SHOTS, 'preview-renderer-info.json'), JSON.stringify(log, null, 2));
if (log.mode !== 'preview') process.exit(1);
console.log('xr preview ok');
