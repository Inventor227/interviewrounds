// Check the converted avatars and animation libraries against manifest.json.
//   node verify.mjs [--dir <avatars dir>] [--manifest <manifest.json>] [--only f01,anims-f]
// Exit code 0 when every check passes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, ImageUtils } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const dir = resolve(opt('dir', join(here, '../../web/public/avatars')));
const manifestPath = resolve(opt('manifest', join(here, 'manifest.json')));
const only = opt('only', '')
  .split(',')
  .filter(Boolean);

const MB = 1024 * 1024;
const MAX_AVATAR_BYTES = 5 * MB;
const MAX_TOTAL_BYTES = 30 * MB;
const MAX_TEXTURE_PX = 1024;
const MIN_JOINTS = 50;
const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'].map((v) => `viseme_${v}`);
const REQUIRED_MORPHS = ['jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight', ...VISEMES];
const CLIPS = [
  'sit_table_breathe_01',
  'idle_neutral_01',
  'idle_neutral_02',
  'gestic_thoughtful',
  'gestic_listen_accept_01',
  'gestic_listen_accept_02',
  'gestic_listen_accept_03',
  'idle_touch_face',
];
// Bones every clip must animate (rotation), so a clip never leaves part of the body in the A-pose.
const BODY = /^Bip01( (Pelvis|Spine\d?|Neck|Head|[LR] (Clavicle|UpperArm|Forearm|Hand|Thigh|Calf|Foot|Toe0|Finger\d+)))?$/;
// three.js names nodes with PropertyBinding.sanitizeNodeName: whitespace becomes "_".
const threeName = (name) => name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

let failures = 0;
const lines = [];
function check(scope, ok, message) {
  if (!ok) failures++;
  lines.push(`${ok ? 'PASS' : 'FAIL'} ${scope}: ${message}`);
}

const wanted = (id) => only.length === 0 || only.includes(id);
const file = (url) => join(dir, basename(url));
const fileSize = (url) => statSync(file(url)).size;
const sha256 = (url) => createHash('sha256').update(readFileSync(file(url))).digest('hex');
function checkRecorded(scope, entry, size) {
  check(scope, entry.bytes === size && entry.sha256 === sha256(entry.glb), 'bytes and sha256 match the manifest');
}

// The app fetches <dir>/manifest.json; the pipeline keeps tools/avatars/manifest.json. They must be identical.
const webManifest = join(dir, 'manifest.json');
const sameManifest = existsSync(webManifest) && readFileSync(webManifest).equals(readFileSync(manifestPath));
check('manifest', sameManifest, `${webManifest} is byte-identical to ${manifestPath}`);

const avatarNodes = new Map(); // id -> Map(name -> parent name)
const avatarJoints = new Map();
let total = 0;

for (const av of manifest.avatars) {
  if (!wanted(av.id)) continue;
  const scope = av.id;
  const size = fileSize(av.glb);
  total += size;
  checkRecorded(scope, av, size);
  check(scope, size <= MAX_AVATAR_BYTES, `size ${(size / MB).toFixed(2)} MB <= 5 MB`);

  const doc = await io.read(file(av.glb));
  const root = doc.getRoot();

  const meshes = root.listMeshes();
  check(scope, meshes.length >= 1, `${meshes.length} mesh(es)`);
  const names = meshes[0]?.getExtras()?.targetNames ?? [];
  const missing = REQUIRED_MORPHS.filter((m) => !names.includes(m));
  check(scope, missing.length === 0, `required morphs present${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
  check(scope, JSON.stringify(names) === JSON.stringify(av.morphs), `${names.length} morph names match manifest`);
  const badCount = meshes.flatMap((m) => m.listPrimitives()).filter((p) => p.listTargets().length !== names.length);
  check(scope, badCount.length === 0, `every primitive has ${names.length} morph targets`);
  const unrenamed = names.filter((n) => /^(AK|AA|AU|HB|SR)_/.test(n));
  check(scope, unrenamed.length === 0, 'no Rocketbox-style morph names left');

  const skins = root.listSkins();
  const joints = skins[0]?.listJoints() ?? [];
  check(scope, skins.length === 1, `${skins.length} skin`);
  check(scope, joints.length > MIN_JOINTS, `${joints.length} joints > ${MIN_JOINTS}`);
  const skinned = root.listNodes().filter((n) => n.getMesh() && n.getSkin());
  check(scope, skinned.length === meshes.length, 'mesh is skinned');

  const nodes = new Map(root.listNodes().map((n) => [n.getName(), n.getParentNode()?.getName() ?? null]));
  avatarNodes.set(av.id, nodes);
  avatarJoints.set(av.id, new Set(joints.map((j) => j.getName())));
  const threeNames = new Set(root.listNodes().map((n) => threeName(n.getName())));
  for (const key of ['head_bone', 'eye_bone']) {
    check(scope, threeNames.has(av[key]), `${key} ${av[key]} exists`);
  }
  for (const eye of av.eye_bones ?? []) check(scope, threeNames.has(eye), `eye bone ${eye} exists`);

  const textures = root.listTextures();
  const bad = textures.filter((t) => {
    const s = ImageUtils.getSize(t.getImage(), t.getMimeType());
    return t.getMimeType() !== 'image/ktx2' || !s || Math.max(...s) > MAX_TEXTURE_PX;
  });
  check(scope, textures.length > 0 && bad.length === 0, `${textures.length} textures, all KTX2 <= ${MAX_TEXTURE_PX} px`);
  const blended = root.listMaterials().filter((m) => m.getAlphaMode() === 'BLEND');
  check(scope, blended.length === 0, 'no alpha-blended materials (hair is alpha-tested)');
  const ext = root.listExtensionsUsed().map((e) => e.extensionName);
  check(scope, ext.includes('EXT_meshopt_compression') && ext.includes('KHR_texture_basisu'), `extensions ${ext.join(', ')}`);
  const anims = root.listAnimations();
  check(scope, anims.length === 0, 'avatar file carries no clips (clips live in the anim library)');
  check(scope, av.height_m > 1.4 && av.height_m < 2.1, `height ${av.height_m} m`);
}

for (const lib of manifest.anim_libraries) {
  if (!wanted(lib.id)) continue;
  const scope = lib.id;
  const size = fileSize(lib.glb);
  total += size;
  checkRecorded(scope, lib, size);
  check(scope, size <= MAX_AVATAR_BYTES, `size ${(size / MB).toFixed(2)} MB`);
  const doc = await io.read(file(lib.glb));
  const root = doc.getRoot();
  check(scope, root.listMeshes().length === 0 && root.listTextures().length === 0, 'skeleton only (no mesh, no texture)');

  const clipNames = root.listAnimations().map((a) => a.getName());
  check(scope, JSON.stringify([...clipNames].sort()) === JSON.stringify([...CLIPS].sort()), `clips ${clipNames.join(', ')}`);
  check(scope, JSON.stringify(clipNames) === JSON.stringify(lib.clips), 'clip list matches manifest');

  const targets = manifest.avatars.filter((a) => a.sex === lib.sex && avatarNodes.has(a.id));
  for (const anim of root.listAnimations()) {
    const name = anim.getName();
    const channels = anim.listChannels();
    const duration = Math.max(...anim.listSamplers().map((s) => s.getInput().getMax([])[0]));
    check(`${scope}/${name}`, channels.length > 0 && duration > 0.5, `${channels.length} tracks, ${duration.toFixed(2)} s`);

    const animated = new Set(channels.filter((c) => c.getTargetPath() === 'rotation').map((c) => c.getTargetNode().getName()));
    for (const av of targets) {
      const nodes = avatarNodes.get(av.id);
      const unbound = channels.filter((c) => !nodes.has(c.getTargetNode().getName()));
      const wrongParent = channels.filter((c) => {
        const n = c.getTargetNode();
        return nodes.has(n.getName()) && nodes.get(n.getName()) !== (n.getParentNode()?.getName() ?? null);
      });
      const body = [...avatarJoints.get(av.id), 'Bip01'].filter((j) => BODY.test(j));
      const uncovered = body.filter((j) => !animated.has(j));
      check(
        `${scope}/${name}`,
        unbound.length === 0 && wrongParent.length === 0 && uncovered.length === 0,
        `binds to ${av.id}: ${channels.length - unbound.length}/${channels.length} tracks resolve, ` +
          `${body.length - uncovered.length}/${body.length} body bones animated` +
          (unbound.length ? ` (unbound ${unbound.map((c) => c.getTargetNode().getName()).join(', ')})` : '') +
          (wrongParent.length ? ` (parent mismatch ${wrongParent.length})` : '') +
          (uncovered.length ? ` (missing ${uncovered.join(', ')})` : ''),
      );
    }
    const bad = channels.filter((c) => {
      const out = c.getSampler().getOutput().getArray();
      return out.some((x) => !Number.isFinite(x));
    });
    check(`${scope}/${name}`, bad.length === 0, 'all keyframe values finite');
  }
}

if (only.length === 0) check('total', total <= MAX_TOTAL_BYTES, `all files ${(total / MB).toFixed(2)} MB <= 30 MB`);

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} (${lines.length} checks)`);
process.exit(failures === 0 ? 0 : 1);
