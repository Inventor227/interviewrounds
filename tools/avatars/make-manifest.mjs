// Write manifest.json from sources.json and the per-avatar info files that rb2glb.py produces.
//   node make-manifest.mjs <info_dir> <out_dir> <manifest.json>
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [infoDir, outDir, manifestPath] = process.argv.slice(2);
const sources = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'));
const threeName = (name) => name.replace(/\s/g, '_');
const URL_BASE = '/avatars/';

let sharedRename = null;
const done = (a) => existsSync(join(infoDir, `${a.id}.json`)) && existsSync(join(outDir, `${a.id}.glb`));
const avatars = sources.avatars.filter(done).map((a) => {
  const info = JSON.parse(readFileSync(join(infoDir, `${a.id}.json`), 'utf8'));
  const rename = info.morph_rename;
  if (!sharedRename) sharedRename = rename;
  const same = JSON.stringify(rename) === JSON.stringify(sharedRename);
  return {
    id: a.id,
    sex: a.sex,
    source: a.source,
    glb: `${URL_BASE}${a.id}.glb`,
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
    bytes: statSync(join(outDir, `${a.id}.glb`)).size,
  };
});

const libs = ['f', 'm']
  .filter((sex) => existsSync(join(outDir, `anims-${sex}.glb`)))
  .map((sex) => ({
    id: `anims-${sex}`,
    sex,
    glb: `${URL_BASE}anims-${sex}.glb`,
    clips: sources.clips.map((c) => c.id),
    sources: Object.fromEntries(sources.clips.map((c) => [c.id, `${sex}_${c.file}.max.fbx`])),
    bytes: statSync(join(outDir, `anims-${sex}.glb`)).size,
  }));

const manifest = {
  version: 1,
  attribution: 'Microsoft Rocketbox avatars and animations, MIT licence. See LICENSE.md.',
  rocketbox_commit: sources.rocketbox.commit,
  notes: [
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

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('MANIFEST_OK', manifestPath, avatars.map((a) => `${a.id}:${a.height_m}m`).join(' '));
