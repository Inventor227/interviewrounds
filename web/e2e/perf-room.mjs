// Emulator run for the frame budget: the conference room with three seated people, the sheet, the wall board with a
// drawing on it and the round panels (bar, brief, captions). Logs renderer.info per view, a per-object breakdown of
// draw calls and triangles, and a texture memory estimate, to <out>/perf.json.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/perf-room.mjs --room conference_room --out plan/shots/t22/perf
// The emulator renders both eyes without multiview, so its calls and triangles are both eyes' worth; a Quest with
// multiview draws each object once for both eyes.

import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, enterXR, screenshot, sleep, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'xr-lib.mjs'), path.join(here, 'xr-lib.mjs'));
const { go, page, startPlacement, stats, waitApp, SAMPLE_ROUND } = await import('./xr-lib.mjs');

const S = { head: { x: 0.0, y: 1.2, z: -0.72 }, tip: { x: 0.02, y: 0.748, z: -1.06 } };
const out = { label: process.env.PERF_LABEL ?? 'run', views: {} };

/** Visible meshes grouped by their top-level object: draw calls (one per material group) and triangles per view. */
function breakdown() {
  const app = globalThis.__xrApp;
  const groups = {};
  const shown = (o) => {
    for (let p = o; p; p = p.parent) if (!p.visible) return false;
    return true;
  };
  app.scene.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints) || !shown(o)) return;
    const g = o.geometry;
    if (!g) return;
    const count = g.index ? g.index.count : g.attributes.position?.count ?? 0;
    const inst = o.isInstancedMesh ? o.count : 1;
    let top = o;
    while (top.parent && top.parent !== app.scene && top.parent.name !== 'room') top = top.parent;
    const key = top.name || top.type;
    const e = (groups[key] ??= { meshes: 0, tris: 0, skinned: 0, morphTargets: 0, names: [] });
    e.meshes++;
    e.tris += o.isMesh ? Math.round((count / 3) * inst) : 0;
    if (o.isSkinnedMesh) e.skinned++;
    e.morphTargets += g.morphAttributes?.position?.length ?? 0;
    if (e.names.length < 6) e.names.push(`${o.name || o.type}:${Math.round(count / 3)}`);
  });
  return groups;
}

/** Bytes of GPU texture memory, estimated from every texture the scene's materials reference. */
function textureEstimate() {
  const app = globalThis.__xrApp;
  const seen = new Set();
  const rows = [];
  let bytes = 0;
  app.scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const v of Object.values(m)) {
        if (!v || !v.isTexture || seen.has(v)) continue;
        seen.add(v);
        const img = v.image ?? {};
        const w = img.width ?? v.source?.data?.width ?? 0;
        const h = img.height ?? v.source?.data?.height ?? 0;
        let b;
        if (v.isCompressedTexture) {
          // Block formats on the headset (ASTC/ETC2): 1 byte per pixel at 8 bpp, mips included.
          b = (v.mipmaps ?? []).reduce((s, mm) => s + (mm.data?.byteLength ?? 0), 0) || w * h;
        } else {
          b = Math.round(w * h * 4 * (v.generateMipmaps ? 4 / 3 : 1));
        }
        bytes += b;
        rows.push({ name: v.name || m.name || o.name, w, h, compressed: !!v.isCompressedTexture, kb: Math.round(b / 1024) });
      }
    }
  });
  rows.sort((a, b) => b.kb - a.kb);
  // three.js keeps morph targets in a float texture: vertices x targets x (position, normal) x RGBA32F.
  let morphBytes = 0;
  const morphRows = [];
  const geos = new Set();
  app.scene.traverse((o) => {
    const g = o.geometry;
    if (!o.isMesh || !g || geos.has(g)) return;
    geos.add(g);
    const targets = g.morphAttributes?.position?.length ?? 0;
    if (!targets) return;
    const attrs = (g.morphAttributes.position ? 1 : 0) + (g.morphAttributes.normal ? 1 : 0) + (g.morphAttributes.color ? 1 : 0);
    const b = g.attributes.position.count * targets * attrs * 16;
    morphBytes += b;
    morphRows.push({ name: o.name, vertices: g.attributes.position.count, targets, kb: Math.round(b / 1024) });
  });
  return {
    mb: Math.round((bytes / 1048576) * 10) / 10,
    morphMb: Math.round((morphBytes / 1048576) * 10) / 10,
    count: rows.length,
    top: rows.slice(0, 12),
    morph: morphRows,
  };
}

const PREVIEW = process.env.PERF_VIEW === 'preview';

async function view(name, pitch, yaw = 0) {
  if (PREVIEW) {
    // The preview's camera: seated eye height, turned by the mouse look; aim it the same way.
    await page(([p, y]) => {
      const cam = globalThis.__xrApp.world.camera;
      cam.rotation.set((p * Math.PI) / 180, (-y * Math.PI) / 180, 0, 'YXZ');
    }, [pitch, yaw]);
  } else {
    await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch, yaw, roll: 0 } });
  }
  await sleep(2500);
  await screenshot(`${out.label}-${name}`);
  const st = await stats();
  const parts = await page(breakdown);
  out.views[name] = { stats: st, parts };
  console.log(name, JSON.stringify(st));
}

const waitStandins = async () => {
  for (let i = 0; i < 40; i++) {
    const n = await page(() => globalThis.__xrApp.standins().filter((s) => s.object.visible).length).catch(() => 0);
    if (n >= 3) return n;
    await sleep(2000);
  }
  return 0;
};

await waitReady();
if (PREVIEW) {
  // Mono, 1280 x 720: the same people, panels and wall board without the stereo XR framebuffer (in passthrough the
  // managed browser ran out of its 2 GB with three people).
  await go(`/session/emu?view=preview&standins=1&seats=3`);
  await waitApp();
  await waitStandins();
} else {
  await go(`/session/emu?offer=1&standins=1&fallback=120&seats=3`);
  await waitApp();
  // As xr-room.mjs: straight into the session (a page capture first crashed the managed browser here).
  await enterXR();
  await sleep(1500);
  await startPlacement();
  await call('xr', 'set-input-mode', { mode: 'hand' });
  await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -38, yaw: 0, roll: 0 } });
  await call('xr', 'set-transform', { device: 'hand-left', position: { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, orientation: 'auto' });
  await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'point' });
  await call('xr', 'set-transform', { device: 'hand-right', position: S.tip, anchor: 'index-tip', orientation: { fingers: [0, -0.85, -0.5], thumb: 'left' } });
  let desk = null;
  for (let i = 0; i < 30 && !desk; i++) {
    await sleep(1000);
    desk = await page(() => globalThis.__xrApp.desk$.value).catch(() => null);
  }
  if (!desk) throw new Error('the desk was not placed');
  await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.28, y: 0.8, z: S.head.z - 0.2 }, orientation: 'auto' });
  await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'default' });
  await waitStandins();
}

// The round chrome and a drawing on the wall board (the board's own canvas size, 1024 x 640).
await page((st) => {
  const app = globalThis.__xrApp;
  app.ui.setRoundState(st);
  app.ui.setCaption('Daniel', 'Good. Walk me through what happens when a user opens a short link for the first time.');
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 640;
  const x = c.getContext('2d');
  x.fillStyle = '#f5f3ee';
  x.fillRect(0, 0, c.width, c.height);
  x.strokeStyle = '#1f4e79';
  x.lineWidth = 6;
  x.strokeRect(120, 160, 260, 150);
  x.strokeRect(620, 160, 260, 150);
  x.beginPath();
  x.moveTo(380, 235);
  x.lineTo(620, 235);
  x.stroke();
  x.font = '40px sans-serif';
  x.fillStyle = '#1f2328';
  x.fillText('API', 200, 250);
  x.fillText('Store', 680, 250);
  const three = app.room.sheet.material.map.constructor;
  const tex = new three(c);
  tex.colorSpace = 'srgb';
  app.wallboardTexture(tex);
}, SAMPLE_ROUND);

await view('1-panel', -16);
await view('2-sheet', -48);
await view('3-wide', -10, 25);
out.textures = await page(textureEstimate);
out.memory = await page(() => {
  const i = globalThis.__xrApp.world.renderer.info;
  return { geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 };
});
out.updateCost = await page(() => {
  // CPU per frame of the stand-ins' animation (the round's avatars do more: gaze, blinks, lip sync).
  const s = globalThis.__xrApp.standins();
  const t0 = performance.now();
  for (let i = 0; i < 72; i++) for (const x of s) x.mixer.update(1 / 72);
  return { mixerMsPerFrame: Math.round(((performance.now() - t0) / 72) * 1000) / 1000, people: s.length };
});
writeFileSync(path.join(process.env.EMU_SHOTS, `${out.label}-perf.json`), JSON.stringify(out, null, 2));
console.log('textures', JSON.stringify(out.textures));
console.log('perf room ok');
