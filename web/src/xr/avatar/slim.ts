// Lighter avatars for the frame budget, with no visible change in a seated room.
//
// - Morph targets only where they move. Every primitive of a converted Rocketbox avatar carries all 59 face shapes,
//   but on the body (and glasses, some hair) every delta is zero. three.js keeps morphs in a float texture
//   (vertices x shapes x position and normal x 16 bytes: about 7 MB for one body) and, since the avatar shares one
//   influence array across its primitives, fetches every active shape for every body vertex each frame.
// - No legs. Seated at the table, thighs, calves and feet are under the slab and behind the desk occluder.
// - A simplified body for the seats after the first (index buffer only, so skinning stays exact): those people sit
//   further away and to the side, and the head, which carries the face, is never simplified.

import { BufferAttribute, type BufferGeometry, type Mesh, type Object3D, type SkinnedMesh } from 'three';

/** Bones whose skin is hidden under the table when seated. */
const LEG_BONE = /(^|[_ ])(L|R)[_ ](Thigh|Calf|Foot|Toe\d*)$/i;

export interface SlimStats {
  /** Primitives that lost their morph targets, and how many shapes each had. */
  morphsDropped: number;
  /** Triangles before and after (all primitives). */
  trianglesBefore: number;
  trianglesAfter: number;
}

const tris = (g: BufferGeometry) => (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3;

function meshesOf(model: Object3D): Mesh[] {
  const out: Mesh[] = [];
  model.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

/** True when every morph target of the geometry leaves it where it is. */
export function morphsAreStill(g: BufferGeometry, eps = 1e-5): boolean {
  for (const list of Object.values(g.morphAttributes)) {
    for (const a of list) {
      const arr = (a as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute ? null : (a.array as ArrayLike<number>);
      if (arr) {
        // Quantized (normalized integer) deltas: any non-zero value moves the vertex.
        for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i]!) > eps) return false;
        continue;
      }
      for (let v = 0; v < a.count; v++) {
        for (let k = 0; k < a.itemSize; k++) if (Math.abs(a.getComponent(v, k)) > eps) return false;
      }
    }
  }
  return true;
}

/** Drops the morph targets of a mesh (one whose shapes never move it). */
function dropMorphs(m: Mesh): void {
  m.geometry.morphAttributes = {};
  m.morphTargetInfluences = undefined;
  m.morphTargetDictionary = undefined;
}

/** The bone each vertex follows most. */
function dominantBones(g: BufferGeometry): Int32Array {
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const n = si.count;
  const out = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    let best = 0;
    let bw = -1;
    for (let k = 0; k < si.itemSize; k++) {
      const w = sw.getComponent(v, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(v, k);
      }
    }
    out[v] = best;
  }
  return out;
}

/** Removes the triangles whose three corners all follow a leg bone. Returns the number removed. */
export function dropLegs(m: SkinnedMesh): number {
  const g = m.geometry;
  if (!m.isSkinnedMesh || !g.index || !g.getAttribute('skinIndex')) return 0;
  const legBone = m.skeleton.bones.map((b) => LEG_BONE.test(b.name));
  if (!legBone.some(Boolean)) return 0;
  const dom = dominantBones(g);
  const isLeg = (v: number) => legBone[dom[v]!] === true;
  const idx = g.index;
  const kept: number[] = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t);
    const b = idx.getX(t + 1);
    const c = idx.getX(t + 2);
    if (isLeg(a) && isLeg(b) && isLeg(c)) continue;
    kept.push(a, b, c);
  }
  const removed = (idx.count - kept.length) / 3;
  if (removed > 0) setIndex(g, kept);
  return removed;
}

function setIndex(g: BufferGeometry, list: ArrayLike<number>): void {
  const n = g.getAttribute('position').count;
  const arr = n < 65536 ? Uint16Array.from(list) : Uint32Array.from(list);
  g.setIndex(new BufferAttribute(arr, 1));
  // Groups would still name the old ranges.
  g.clearGroups();
}

/**
 * Slims a freshly loaded avatar model in place (before it is wrapped in an Avatar): still morphs dropped, legs
 * removed. Primitives whose morphs move (the head, eyelashes) keep them.
 */
export function slimAvatar(model: Object3D): SlimStats {
  const meshes = meshesOf(model);
  const stats: SlimStats = { morphsDropped: 0, trianglesBefore: 0, trianglesAfter: 0 };
  for (const m of meshes) stats.trianglesBefore += tris(m.geometry);
  // Each primitive's shapes are scanned once (the body carries every face shape: about a million deltas).
  const still = new Map<Mesh, boolean>();
  for (const m of meshes) if (m.geometry.morphAttributes.position?.length) still.set(m, morphsAreStill(m.geometry));
  // Only when some primitive's shapes do move (the face): a model with none moving is left to its owner.
  const faces = [...still.values()].some((s) => !s);
  for (const m of meshes) {
    if (faces && still.get(m) === true) {
      dropMorphs(m);
      stats.morphsDropped++;
    }
    if ((m as SkinnedMesh).isSkinnedMesh && !m.geometry.morphAttributes.position?.length) dropLegs(m as SkinnedMesh);
  }
  for (const m of meshes) stats.trianglesAfter += tris(m.geometry);
  return stats;
}

/** The body: the largest primitive without moving morphs (never the face). */
export function bodyMesh(model: Object3D): Mesh | null {
  let best: Mesh | null = null;
  for (const m of meshesOf(model)) {
    if (m.geometry.morphAttributes.position?.length || !m.geometry.index) continue;
    if (!best || tris(m.geometry) > tris(best.geometry)) best = m;
  }
  return best;
}

type Simplifier = {
  ready: Promise<void>;
  simplify(indices: Uint32Array, positions: Float32Array, stride: number, target: number, error: number, flags?: string[]): [Uint32Array, number];
};
let simplifier: Promise<Simplifier> | null = null;

/**
 * Loads the simplifier (a lazy chunk and its wasm) ahead of time, so the side seats' simplified bodies are ready
 * before those people first show. Never rejects.
 */
export function warmSimplifier(): Promise<void> {
  return loadSimplifier().then(
    () => undefined,
    () => undefined,
  );
}

function loadSimplifier(): Promise<Simplifier> {
  simplifier ??= import('three/examples/jsm/libs/meshopt_simplifier.module.js').then(async (m) => {
    const s: Simplifier = m.MeshoptSimplifier;
    await s.ready;
    return s;
  });
  simplifier.catch(() => (simplifier = null));
  return simplifier;
}

/**
 * A simplified index for a mesh (vertices untouched, so skin weights and any morphs still apply), about `ratio` of
 * its triangles, keeping the open borders (collar, cuffs) where they are. Null when it could not be made.
 */
export async function simplifiedIndex(m: Mesh, ratio: number, error = 0.02): Promise<BufferAttribute | null> {
  const g = m.geometry;
  if (!g.index) return null;
  const s = await loadSimplifier().catch(() => null);
  if (!s) return null;
  const pos = g.getAttribute('position');
  const p = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    p[i * 3] = pos.getX(i);
    p[i * 3 + 1] = pos.getY(i);
    p[i * 3 + 2] = pos.getZ(i);
  }
  const idx = Uint32Array.from({ length: g.index.count }, (_, i) => g.index!.getX(i));
  const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3);
  const [out] = s.simplify(idx, p, 3, target, error, ['LockBorder']);
  if (!out.length) return null;
  const arr = pos.count < 65536 ? Uint16Array.from(out) : Uint32Array.from(out);
  return new BufferAttribute(arr, 1);
}

/** Switches a body between its full and its simplified index; the simplified one is made on first use. */
export class BodyDetail {
  private full: BufferAttribute | null = null;
  private lod: Promise<BufferAttribute | null> | null = null;
  private want: 0 | 1 = 0;

  constructor(
    private readonly body: Mesh | null,
    private readonly ratio = 0.5,
  ) {}

  /** 0: full detail; 1: simplified. Resolves once the change is applied (or found impossible). */
  async set(level: 0 | 1): Promise<void> {
    const body = this.body;
    if (!body) return;
    this.want = level;
    this.full ??= body.geometry.index as BufferAttribute | null;
    if (level === 0) {
      if (this.full) body.geometry.setIndex(this.full);
      return;
    }
    this.lod ??= simplifiedIndex(body, this.ratio);
    const lod = await this.lod;
    // Asked for full detail again while it was being made.
    if (this.want !== 1 || !lod) return;
    body.geometry.setIndex(lod);
  }

  get level(): 0 | 1 {
    return this.body && this.lod && this.body.geometry.index !== this.full ? 1 : 0;
  }
}
