// Write manifest.json from sources.json and the per-avatar info files that rb2glb.py produces.
//   node make-manifest.mjs <info_dir> <out_dir> <manifest.json> [more copies...]
//
// Every path given gets the same bytes: tools/avatars/manifest.json (pipeline record) and
// web/public/avatars/manifest.json (fetched by the app as /avatars/manifest.json). URLs inside are
// web paths (/avatars/...).
//
// An avatar without a fresh info file (not converted in this run) keeps its entry from the existing
// manifest (the first path), with bytes and sha256 re-read from its GLB. If an avatar listed in
// sources.json would still be missing, nothing is written and the exit code is 1.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [infoDir, outDir, ...manifestPaths] = process.argv.slice(2);
if (!infoDir || !outDir || manifestPaths.length === 0) {
  console.error('usage: node make-manifest.mjs <info_dir> <out_dir> <manifest.json> [more copies...]');
  process.exit(2);
}
const sources = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'));
const previous = existsSync(manifestPaths[0]) ? JSON.parse(readFileSync(manifestPaths[0], 'utf8')) : null;
const threeName = (name) => name.replace(/\s/g, '_');
const URL_BASE = '/avatars/';

const fileFacts = (name) => {
  const path = join(outDir, name);
  const buf = readFileSync(path);
  return { bytes: statSync(path).size, sha256: createHash('sha256').update(buf).digest('hex') };
};

let sharedRename = previous?.morph_rename ?? null;
const missing = [];
const avatars = [];
for (const a of sources.avatars) {
  const infoPath = join(infoDir, `${a.id}.json`);
  const glbName = `${a.id}.glb`;
  if (!existsSync(join(outDir, glbName))) {
    missing.push(a.id);
    continue;
  }
  if (existsSync(infoPath)) {
    const info = JSON.parse(readFileSync(infoPath, 'utf8'));
    const rename = info.morph_rename;
    if (!sharedRename) sharedRename = rename;
    const same = JSON.stringify(rename) === JSON.stringify(sharedRename);
    avatars.push({
      id: a.id,
      sex: a.sex,
      source: a.source,
      glb: `${URL_BASE}${glbName}`,
      anims: `${URL_BASE}anims-${a.sex}.glb`,
      height_m: info.height_m,
      eye_bone: threeName('Bip01 LEye'),
      eye_bones: [threeName('Bip01 LEye'), threeName('Bip01 REye')],
      head_bone: threeName('Bip01 Head'),
      neck_bone: threeName('Bip01 Neck'),
      morphs: Object.values(rename),
      ...(same ? {} : { morph_rename: rename }),
      tris: info.tris,
      joints: info.bones.length,
      ...fileFacts(glbName),
    });
    continue;
  }
  const old = previous?.avatars?.find((x) => x.id === a.id);
  if (!old) {
    missing.push(a.id);
    continue;
  }
  avatars.push({ ...old, ...fileFacts(glbName) });
}

const libs = [];
for (const sex of ['f', 'm']) {
  if (!sources.avatars.some((a) => a.sex === sex)) continue;
  const name = `anims-${sex}.glb`;
  if (!existsSync(join(outDir, name))) {
    missing.push(`anims-${sex}`);
    continue;
  }
  libs.push({
    id: `anims-${sex}`,
    sex,
    glb: `${URL_BASE}${name}`,
    clips: sources.clips.map((c) => c.id),
    sources: Object.fromEntries(sources.clips.map((c) => [c.id, `${sex}_${c.file}.max.fbx`])),
    ...fileFacts(name),
  });
}

if (missing.length) {
  console.error(`refusing to write a partial manifest: no output or entry for ${missing.join(', ')}`);
  process.exit(1);
}

const manifest = {
  version: 1,
  attribution: 'Microsoft Rocketbox avatars and animations, MIT licence. See LICENSE.md.',
  rocketbox_commit: sources.rocketbox.commit,
  notes: [
    'Fetch at run time from /avatars/manifest.json; glb and anims are web paths under /avatars/.',
    'Bone names are three.js object names (GLTFLoader turns spaces into underscores).',
    'Load with GLTFLoader plus MeshoptDecoder and KTX2Loader.',
    'Hair, lashes and glasses are alpha-tested (alphaMode MASK, cutoff 0.5); no blended materials.',
    'Clips bind by bone name: play anims-<sex>.glb clips on the avatar scene with one AnimationMixer.',
    'Clips animate body bones only: face bones, eyes and jaw are left to morph targets and gaze code.',
    'Translation is animated only on Bip01, Bip01_Pelvis and Bip01_Spine, so each avatar keeps its proportions.',
    'gestic_listen_accept_* are standing listening nods layered onto the seated breathe clip (Spine1, Spine2, Neck, Head), so they are full-body seated clips.',
  ],
  morph_rename: sharedRename,
  avatars,
  anim_libraries: libs,
};

const text = `${JSON.stringify(manifest, null, 2)}\n`;
for (const p of manifestPaths) writeFileSync(p, text);
console.log('MANIFEST_OK', manifestPaths.join(' '), avatars.map((a) => `${a.id}:${a.height_m}m`).join(' '));
