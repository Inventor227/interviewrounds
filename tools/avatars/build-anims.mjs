// Merge per-clip GLBs (one Rocketbox armature + one action each) into one skeleton-only animation library.
//   node build-anims.mjs <out.glb> <ref_avatar.glb> <base_clip_id> <id=clip.glb[@overlay]> ...
//
// Clips bind by node name, so every channel is retargeted onto the nodes of the first clip and checked
// against the reference avatar's skeleton. glTF channels hold absolute local TRS values, so the differing
// rest poses of the Rocketbox clip files do not matter.
//
// Rules per channel:
// - only nodes that exist in the reference avatar (drops the `*Nub` end bones)
// - no face bones (eyes, jaw, lips, brows): the face is driven by morph targets and gaze code
// - translation only on the root chain (Bip01, Pelvis, Spine), so each avatar keeps its own proportions
// - no scale
//
// `@overlay` clips are standing upper-body motions (listening nods). They are layered onto the seated base
// clip as a local rotation delta on Spine1, Spine2, Neck and Head, so the result is a full-body seated clip
// that crossfades cleanly with the others.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, resample, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [out, refPath, baseId, ...specs] = process.argv.slice(2);
if (!out || !refPath || !baseId || specs.length === 0) {
  console.error('usage: node build-anims.mjs <out.glb> <ref.glb> <base_clip_id> <id=clip.glb[@overlay]> ...');
  process.exit(2);
}

const FACE = /^Bip01 (?:[LR]Eye|MJaw|MBottomLip|MTongue|[LR]MouthBottom|[LR]Masseter|MUpperLip|[LR]Caninus|[LR]EyeBlink(?:Top|Bottom)|[LR]Upperlip|[LR]MouthCorner|[LR]Cheek|[LR]InnerEyebrow|MMiddleEyebrow|[LR]OuterEyebrow|MNose)$/;
const ROOT_CHAIN = new Set(['Bip01', 'Bip01 Pelvis', 'Bip01 Spine']);
const OVERLAY_BONES = new Set(['Bip01 Spine1', 'Bip01 Spine2', 'Bip01 Neck', 'Bip01 Head']);

await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const clips = specs.map((s) => {
  const [id, rest] = s.split('=');
  const [path, flag] = rest.split('@');
  return { id, path, overlay: flag === 'overlay' };
});
const baseClip = clips.find((c) => c.id === baseId);
if (!baseClip) throw new Error(`base clip ${baseId} not in list`);

// Allowed target nodes: every node of the reference avatar except meshes.
const ref = await io.read(refPath);
const refNodes = new Set(ref.getRoot().listNodes().filter((n) => !n.getMesh()).map((n) => n.getName()));

// The library document starts as the base clip file: its node tree becomes the shared skeleton.
const doc = await io.read(baseClip.path);
const root = doc.getRoot();
for (const anim of root.listAnimations()) anim.dispose();
for (const node of root.listNodes()) {
  if (!refNodes.has(node.getName())) {
    for (const child of node.listChildren()) node.removeChild(child);
    node.dispose();
  }
}
const nodeByName = new Map(root.listNodes().map((n) => [n.getName(), n]));
const buffer = root.listBuffers()[0];

function keep(name, path) {
  if (!nodeByName.has(name)) return false;
  if (FACE.test(name)) return false;
  if (path === 'scale' || path === 'weights') return false;
  if (path === 'translation' && !ROOT_CHAIN.has(name)) return false;
  return true;
}

function readTrack(channel) {
  const sampler = channel.getSampler();
  const times = Array.from(sampler.getInput().getArray());
  const out = sampler.getOutput();
  const size = out.getElementSize();
  const values = Array.from(out.getArray());
  return { times, size, values, interpolation: sampler.getInterpolation() };
}

function sampleTrack(track, t) {
  const { times, size, values } = track;
  if (t <= times[0]) return values.slice(0, size);
  const last = times.length - 1;
  if (t >= times[last]) return values.slice(last * size, last * size + size);
  let i = 0;
  while (times[i + 1] < t) i++;
  const a = values.slice(i * size, i * size + size);
  const b = values.slice((i + 1) * size, (i + 1) * size + size);
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  if (size === 4) return slerp(a, b, u);
  return a.map((x, j) => x + (b[j] - x) * u);
}

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => {
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
};
function slerp(a, b, u) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    b = b.map((x) => -x);
    dot = -dot;
  }
  if (dot > 0.9995) return qnorm(a.map((x, j) => x + (b[j] - x) * u));
  const th = Math.acos(dot);
  const s = Math.sin(th);
  const wa = Math.sin((1 - u) * th) / s;
  const wb = Math.sin(u * th) / s;
  return a.map((x, j) => x * wa + b[j] * wb);
}

function addChannel(anim, name, path, times, values, interpolation = 'LINEAR') {
  const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer);
  const type = path === 'rotation' ? 'VEC4' : 'VEC3';
  const output = doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(interpolation);
  const channel = doc.createAnimationChannel().setTargetNode(nodeByName.get(name)).setTargetPath(path).setSampler(sampler);
  anim.addSampler(sampler).addChannel(channel);
}

async function loadTracks(path) {
  const src = await io.read(path);
  const anim = src.getRoot().listAnimations()[0];
  const tracks = new Map();
  for (const ch of anim.listChannels()) {
    const name = ch.getTargetNode().getName();
    const p = ch.getTargetPath();
    if (keep(name, p)) tracks.set(`${name}|${p}`, readTrack(ch));
  }
  return tracks;
}

const baseTracks = await loadTracks(baseClip.path);
const report = [];

for (const clip of clips) {
  const tracks = clip.overlay ? null : clip.id === baseId ? baseTracks : await loadTracks(clip.path);
  const anim = doc.createAnimation(clip.id);
  if (!clip.overlay) {
    for (const [key, tr] of tracks) {
      const [name, p] = key.split('|');
      addChannel(anim, name, p, tr.times, tr.values, tr.interpolation);
    }
  } else {
    const overlay = await loadTracks(clip.path);
    const duration = Math.max(...[...overlay.values()].map((t) => t.times[t.times.length - 1]));
    const frames = Math.round(duration * 30);
    const times = Array.from({ length: frames + 1 }, (_, i) => i / 30);
    for (const [key, tr] of baseTracks) {
      const [name, p] = key.split('|');
      const ov = overlay.get(key);
      const values = [];
      for (const t of times) {
        let v = sampleTrack(tr, t);
        if (p === 'rotation' && OVERLAY_BONES.has(name) && ov) {
          const first = ov.values.slice(0, 4);
          const delta = qmul(qinv(first), sampleTrack(ov, t));
          v = qnorm(qmul(v, delta));
        }
        values.push(...v);
      }
      addChannel(anim, name, p, times, values);
    }
  }
  report.push({ id: clip.id, channels: anim.listChannels().length });
}

await doc.transform(resample({ tolerance: 1e-4 }), dedup(), prune({ keepLeaves: true }));
await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(out, doc);

const durations = root.listAnimations().map((a) => {
  const max = Math.max(...a.listSamplers().map((s) => s.getInput().getMax([])[0]));
  return `${a.getName()}:${max.toFixed(2)}s/${a.listChannels().length}ch`;
});
console.log('ANIMS_OK', out, root.listNodes().length, 'nodes', durations.join(' '));
