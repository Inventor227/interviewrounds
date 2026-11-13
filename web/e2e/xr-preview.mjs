// Emulator run for the 2D preview (no WebXR path): the room in the page, stage stretched to the viewport for the
// shot. Screens with 1 and 3 seats, live chrome and the summary; logs render stats.
// Run it with the headless emulator at a 1280×720 viewport.

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'xr-lib.mjs'), path.join(here, 'xr-lib.mjs'));
const { go, page, stats, viewport, waitApp, SAMPLE_ROUND, SAMPLE_SUMMARY } = await import('./xr-lib.mjs');

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

// The canvas follows its 16:9 stage in the page through window resizes (IWSDK's own handler sizes it to the window).
const fitCheck = () =>
  page(() => {
    const canvas = globalThis.__xrApp.world.renderer.domElement;
    const stage = canvas.parentElement.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    return {
      window: [innerWidth, innerHeight],
      stage: [Math.round(stage.width), Math.round(stage.height)],
      canvas: [Math.round(c.width), Math.round(c.height)],
      buffer: [canvas.width, canvas.height],
      aspect: +globalThis.__xrApp.world.camera.aspect.toFixed(3),
    };
  });
const fits = (f) =>
  Math.abs(f.canvas[0] - f.stage[0]) <= 1 &&
  Math.abs(f.canvas[1] - f.stage[1]) <= 1 &&
  Math.abs(f.aspect - f.stage[0] / f.stage[1]) < 0.01 &&
  Math.abs(f.buffer[0] / f.buffer[1] - f.stage[0] / f.stage[1]) < 0.02;
await sleep(2000);
log.fit = [await fitCheck()];
await viewport(900, 1000);
await sleep(2500);
log.fit.push(await fitCheck());
await shot('preview-0-stage-after-resize');
await viewport(1280, 720);
await sleep(2500);
log.fit.push(await fitCheck());
log.fitOk = log.fit.every(fits);
console.log('fit', JSON.stringify(log.fit), log.fitOk);

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

// The Tap to hear card (the controller shows it when the interviewer cannot be heard).
await page(() => {
  const app = globalThis.__xrApp;
  app.ui.hideSummary();
  app.ui.setStatus('hear');
});
await sleep(1500);
await shot('preview-hear');

// destroy() frees the renderer: context lost, canvas gone.
log.destroy = await page(() => {
  const app = globalThis.__xrApp;
  const r = app.world.renderer;
  const gl = r.getContext();
  const canvas = r.domElement;
  app.destroy();
  return { contextLost: gl.isContextLost(), canvasInPage: document.contains(canvas) };
});
console.log('destroy', JSON.stringify(log.destroy));

writeFileSync(path.join(process.env.EMU_SHOTS, 'preview-renderer-info.json'), JSON.stringify(log, null, 2));
const problems = [];
if (log.mode !== 'preview') problems.push('not in preview');
if (!log.fitOk) problems.push('canvas left its stage after a resize');
if (!log.destroy?.contextLost || log.destroy?.canvasInPage) problems.push('destroy kept the context or canvas');
if (problems.length) {
  console.error('xr preview problems:', problems.join('; '));
  process.exit(1);
}
console.log('xr preview ok');
