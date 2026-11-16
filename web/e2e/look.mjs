// Emulator run for how the panel looks: seated people (LOOK_SEATS, default 2) seen from the user's chair, then close
// views of the lead and of the second seat at about conversation distance, and a view from the side (table, shadows,
// chairs). Same cameras and a frozen clip pose on every run, so before and after captures line up. Writes PNGs and
// <label>-look.json (render stats per view, the avatar materials).
//
// Runs the flat preview (`view=preview`): it has the same people, materials, IBL and key light as the passthrough
// room (exposure 1.0 and IBL 0.6 instead of 0.9 and 0.85, plus the preview's own walls and window light). The
// passthrough page with stand-ins crashes the managed browser in its 2 GB container, and so does the preview with
// three people now and then.
//   Emulator run (see README.md): viewport 800x600. Variables: LOOK_LABEL (file prefix), LOOK_SEATS. About 4 minutes.

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'xr-lib.mjs'), path.join(here, 'xr-lib.mjs'));
const { go, page, stats, waitApp } = await import('./xr-lib.mjs');

const label = process.env.LOOK_LABEL ?? 'run';
const SEATS = Number(process.env.LOOK_SEATS ?? 2);
const out = { label, views: {} };

async function shot(name) {
  await sleep(1500);
  await screenshot(`${label}-${name}`);
  out.views[name] = await stats().catch((e) => ({ error: String(e).slice(0, 200) }));
  console.log(name, JSON.stringify(out.views[name]));
}

await waitReady();
await go(`/session/emu?view=preview&standins=1&seats=${SEATS}`);
await waitApp();
for (let i = 0; i < 40; i++) {
  const n = await page(() => globalThis.__xrApp.standins().filter((s) => s.object.visible).length).catch(() => 0);
  if (n >= SEATS) break;
  await sleep(2000);
}

// The preview stage fills the viewport (the page around it is not part of the look).
await page(() => {
  const host = globalThis.__xrApp.world.renderer.domElement.parentElement;
  host.style.cssText += ';position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;border-radius:0;margin:0';
  return true;
});
await sleep(2000);

// Pin the clip pose, and take the camera from the preview's mouse look (which sets it every frame).
out.setup = await page(() => {
  const app = globalThis.__xrApp;
  for (const s of app.standins()) {
    s.mixer.setTime(2.5);
    s.mixer.timeScale = 0;
  }
  const cam = app.world.camera;
  globalThis.__lookCam = { pos: cam.position.clone(), rot: cam.rotation.clone() };
  cam.position.set = function () {
    return this;
  };
  cam.rotation.set = function () {
    return this;
  };
  const mats = [];
  for (const s of app.standins())
    s.object.traverse((o) => {
      if (o.isMesh) mats.push({ id: s.id, name: o.material.name, rough: o.material.roughness, key: o.material.customProgramCacheKey?.().slice(0, 40) });
    });
  const heads = app.standins().map((s) => {
    const h = s.object.getObjectByName('Bip01_Head');
    h.updateWorldMatrix(true, false);
    const p = h.getWorldPosition(h.position.clone());
    return { id: s.id, x: p.x, y: p.y, z: p.z };
  });
  return { heads, mats, cam: globalThis.__lookCam };
});
console.log('setup', JSON.stringify(out.setup));

/** Camera at `from`, looking at `at` (world). Null `from` restores the user's seat. */
const aim = (from, at) =>
  page(
    ([from, at]) => {
      const cam = globalThis.__xrApp.world.camera;
      const home = globalThis.__lookCam;
      if (!from) {
        cam.position.copy(home.pos);
        cam.rotation.copy(home.rot);
      } else {
        cam.position.copy(home.pos.clone().set(from.x, from.y, from.z));
        cam.lookAt(at.x, at.y, at.z);
      }
      cam.updateMatrixWorld();
      return true;
    },
    [from, at],
  );

const [lead, second] = out.setup.heads;
await aim(null);
await shot('1-panel');
// Lead and second seat from 0.8 m, on the line toward the user's chair.
for (const [name, h] of [
  ['2-lead-close', lead],
  ['3-second-close', second],
]) {
  if (!h) continue;
  const home = out.setup.cam.pos;
  const dx = home.x - h.x;
  const dz = home.z - h.z;
  const d = Math.hypot(dx, dz);
  await aim({ x: h.x + (dx / d) * 0.8, y: h.y + 0.02, z: h.z + (dz / d) * 0.8 }, { x: h.x, y: h.y - 0.02, z: h.z });
  await shot(name);
}
// From the user's right, lower: the forearms on the table, the contact shadows and the chairs.
if (lead) {
  const home = out.setup.cam.pos;
  await aim({ x: home.x + 0.55, y: home.y - 0.1, z: home.z + (lead.z - home.z) * 0.35 }, { x: lead.x, y: lead.y - 0.45, z: lead.z });
  await shot('4-lead-side');
}
writeFileSync(path.join(process.env.EMU_SHOTS, `${label}-look.json`), JSON.stringify(out, null, 2));
console.log('look ok');
