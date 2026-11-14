// Emulator run for the frame budget in a real room: a meeting with three people (the exec update template: three
// attendees),
// the meeting sheet, the wall board and the round panels, with the typed-turn fake voice against the deployed server.
// Logs renderer.info per view, a per-object breakdown of draw calls and triangles, and a texture memory estimate
// (with three.js's morph target textures), to <out>/<label>-perf.json, then ends the round.
//   Emulator run (see README.md): room conference_room; env DEV_KEY and IR_API_ORIGIN; allow up to 30 minutes.
// The emulator draws both eyes without multiview, so its calls and triangles are both eyes' worth.
import { copyFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, click, enterFromTap, go, look, page, placeDesk, recordRound, setupTab, shot, sleep, stage, until, waitState } = L;
const S = L.SETUPS.conference_room;
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

async function view(name, pitch, yaw = 0) {
  await look(S, pitch, yaw);
  await sleep(2500);
  await shot(`${out.label}-${name}`);
  out.views[name] = { stats: await page(() => globalThis.__xrApp.stats()), parts: await page(breakdown) };
  console.log(name, JSON.stringify(out.views[name].stats));
}

await waitReady();
const TEMPLATE = process.env.TEMPLATE ?? 'exec_update';
await go(`/meeting/new?template=${TEMPLATE}`);
await until('the meeting setup', () => !!document.querySelector('[data-test="prepare"]'));
await setupTab();
await click('prepare');
await until('the prepared meeting', () => !!document.querySelector('[data-test="prepared"]'), null, 120000);
await click('mic-allow');
await until('the room ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await enterFromTap('start-round');
await recordRound();
const desk = await placeDesk(S);
stage('desk placed', desk);
await waitState(['live'], 120000);
// Everyone seated and faded in.
out.seated = await until('everyone in the room', () => {
  const n = [];
  globalThis.__xrApp.room.root.traverse((o) => o.name.startsWith('avatar-') && o.visible && n.push(o.name));
  return n.length >= globalThis.__round.session.panel.length ? n : null;
}, null, 90000, 2000);
out.people = await page(() => globalThis.__round.session.panel.map((p) => ({ id: p.panelist_id, avatar: p.avatar_id, seat: p.seat })));
await view('1-panel', -12, 0);
await view('2-sheet', -50, 0);
await view('3-side', -10, 30);
out.textures = await page(textureEstimate);
out.memory = await page(() => {
  const i = globalThis.__xrApp.world.renderer.info;
  return { geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 };
});
writeFileSync(path.join(process.env.EMU_SHOTS, `${out.label}-perf.json`), JSON.stringify(out, null, 2));
await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 60000).catch(() => undefined);
console.log('textures', JSON.stringify(out.textures));
console.log('perf meeting ok');
