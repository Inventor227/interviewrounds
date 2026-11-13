// @vitest-environment node
// Slimming on the real converted avatars: still morphs and legs go, the face keeps every shape it moves, and the
// side seats' simplified body is about half the triangles with the same vertices (skinning stays exact).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Texture, type Mesh, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { Avatar } from './avatar';
import { BodyDetail, bodyMesh, morphsAreStill, slimAvatar } from './slim';
import type { AvatarManifest } from './types';

(globalThis as { self?: unknown }).self ??= globalThis;
const PUB = path.join(__dirname, '..', '..', '..', 'public');
const ktx2Stub = {
  load(_url: string, onLoad: (t: Texture) => void) {
    onLoad(new Texture());
  },
  dispose() {},
};

function parse(file: string): Promise<GLTF> {
  const buf = readFileSync(path.join(PUB, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  (loader as unknown as { setKTX2Loader(l: unknown): void }).setKTX2Loader(ktx2Stub);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

const manifest = JSON.parse(readFileSync(path.join(PUB, 'avatars', 'manifest.json'), 'utf8')) as AvatarManifest;
const meshes = (o: Object3D) => {
  const out: Mesh[] = [];
  o.traverse((x) => {
    if ((x as Mesh).isMesh) out.push(x as Mesh);
  });
  return out;
};
const tris = (m: Mesh) => m.geometry.index!.count / 3;
const shapes = (m: Mesh) => m.geometry.morphAttributes.position?.length ?? 0;

describe('slim avatars', () => {
  it.each(manifest.avatars.map((a) => a.id))('%s_loses_still_morphs_and_legs_and_keeps_the_face', async (id) => {
    const entry = manifest.avatars.find((a) => a.id === id)!;
    const g = await parse(entry.glb.slice(1));
    const before = meshes(g.scene).map((m) => ({ name: m.name, tris: tris(m), shapes: shapes(m), still: morphsAreStill(m.geometry) }));
    const s = slimAvatar(g.scene);
    const after = meshes(g.scene);
    // The face primitive keeps all its shapes and every triangle.
    const face = before.find((b) => !b.still && b.shapes > 50)!;
    const faceAfter = after.find((m) => m.name === face.name)!;
    expect(shapes(faceAfter)).toBe(face.shapes);
    expect(tris(faceAfter)).toBe(face.tris);
    expect(faceAfter.morphTargetInfluences).toHaveLength(face.shapes);
    // Every primitive whose shapes never moved lost them; the body is one of them.
    for (const b of before) {
      const m = after.find((x) => x.name === b.name)!;
      expect(shapes(m) === 0).toBe(b.still);
    }
    expect(s.morphsDropped).toBe(before.filter((b) => b.still).length);
    // The legs went, the upper body stayed.
    const body = before.reduce((x, y) => (y.still && y.tris > x.tris ? y : x));
    const bodyAfter = tris(after.find((m) => m.name === body.name)!);
    expect(bodyAfter).toBeLessThan(body.tris * 0.85);
    expect(bodyAfter).toBeGreaterThan(body.tris * 0.55);
    expect(s.trianglesAfter).toBe(s.trianglesBefore - (body.tris - bodyAfter));
    // No triangle left hangs only on leg bones.
    const sk = after.find((m) => m.name === body.name) as SkinnedMesh;
    const legs = sk.skeleton.bones.map((b) => /(Thigh|Calf|Foot|Toe)/.test(b.name));
    const si = sk.geometry.getAttribute('skinIndex');
    const sw = sk.geometry.getAttribute('skinWeight');
    const top = (v: number) => {
      let best = 0;
      for (let k = 1; k < 4; k++) if (sw.getComponent(v, k) > sw.getComponent(v, best)) best = k;
      return si.getComponent(v, best);
    };
    const idx = sk.geometry.index!;
    for (let t = 0; t < idx.count; t += 3) {
      expect([0, 1, 2].every((k) => legs[top(idx.getX(t + k))])).toBe(false);
    }
  });

  it('the_avatar_still_blinks_and_moves_its_lips_after_slimming', async () => {
    const entry = manifest.avatars.find((a) => a.id === 'f01')!;
    const [g, anims] = await Promise.all([parse(entry.glb.slice(1)), parse(entry.anims.slice(1))]);
    const a = Avatar.fromModel(entry, g.scene, anims.animations, { seed: 3 });
    expect(a.slim!.morphsDropped).toBeGreaterThan(0);
    a.place({ position: { x: 0, y: 0, z: 0 }, yaw: 0, deskY: 0.74 });
    a.setMode('speaking');
    const face = meshes(g.scene).find((m) => shapes(m) > 50)!;
    let moved = 0;
    for (let i = 0; i < 72 * 8; i++) {
      a.update(1 / 72);
      moved = Math.max(moved, ...face.morphTargetInfluences!);
    }
    expect(moved).toBeGreaterThan(0.2);
    // Kept whole when asked (a full-body view).
    const g2 = await parse(entry.glb.slice(1));
    const whole = Avatar.fromModel(entry, g2.scene, anims.animations, { seated: false });
    expect(whole.slim).toBeNull();
    expect(meshes(g2.scene).every((m) => shapes(m) === 59)).toBe(true);
  });

  it('a_side_seat_body_is_about_half_and_switches_back_in_full', async () => {
    const g = await parse('avatars/m04.glb');
    slimAvatar(g.scene);
    const body = bodyMesh(g.scene)!;
    expect(shapes(body)).toBe(0);
    const full = tris(body);
    const vertices = body.geometry.getAttribute('position').count;
    const d = new BodyDetail(body);
    await d.set(1);
    expect(d.level).toBe(1);
    expect(tris(body)).toBeLessThan(full * 0.65);
    expect(tris(body)).toBeGreaterThan(full * 0.3);
    expect(body.geometry.getAttribute('position').count).toBe(vertices);
    const maxIndex = Math.max(...Array.from(body.geometry.index!.array as ArrayLike<number>));
    expect(maxIndex).toBeLessThan(vertices);
    await d.set(0);
    expect(tris(body)).toBe(full);
    expect(d.level).toBe(0);
    // Back to the side seat: the simplified index is made once.
    await d.set(1);
    expect(tris(body)).toBeLessThan(full * 0.65);
  });
});
