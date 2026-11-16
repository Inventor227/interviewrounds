// @vitest-environment node
// Passthrough materials on the real converted avatars: parts are found by name, roughness is set once, and the eye
// gloss rectangle holds the eyeballs on every head and no skin around them (bar a stray corner vertex).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MeshStandardMaterial, Texture, type Mesh, type SkinnedMesh } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { EYE_ROUGHNESS, EYE_UV, ROUGHNESS, dressAvatar, eyeGlossShader, partOf } from './look';
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

const meshes = (g: GLTF) => {
  const out: Mesh[] = [];
  g.scene.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
};

describe('avatar look', () => {
  it('parts_come_from_material_names', () => {
    expect(partOf('m015_body')).toBe('cloth');
    expect(partOf('f014_head')).toBe('skin');
    expect(partOf('f014_opacity')).toBe('hair');
    expect(partOf('f015_glasses')).toBe('other');
  });

  it('dress_sets_matte_cloth_and_skin_once', async () => {
    const g = await parse('avatars/f01.glb');
    dressAvatar(g.scene);
    const byPart: Record<string, MeshStandardMaterial> = {};
    for (const m of meshes(g)) {
      const mat = m.material as MeshStandardMaterial;
      byPart[partOf(mat.name)] = mat;
    }
    expect(byPart.cloth!.roughness).toBe(ROUGHNESS.cloth);
    expect(byPart.skin!.roughness).toBe(ROUGHNESS.skin);
    expect(byPart.hair!.roughness).toBe(ROUGHNESS.hair);
    // Only the head gets the eye gloss, and a second pass changes nothing.
    expect(byPart.skin!.customProgramCacheKey()).toBe('avatar-eye-gloss');
    expect(byPart.cloth!.onBeforeCompile.toString()).not.toContain('eyeGloss');
    const hook = byPart.skin!.onBeforeCompile;
    byPart.skin!.roughness = 0.3;
    dressAvatar(g.scene);
    expect(byPart.skin!.roughness).toBe(0.3);
    expect(byPart.skin!.onBeforeCompile).toBe(hook);
  });

  it('eye_gloss_patches_the_roughness_chunk', () => {
    const src = 'void main() {\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n}';
    const out = eyeGlossShader(src);
    expect(out).toContain('#include <roughnessmap_fragment>');
    expect(out).toContain('vMapUv');
    expect(out).toContain(`mix(roughnessFactor, ${EYE_ROUGHNESS}`);
    expect(out.indexOf('eyeMask')).toBeGreaterThan(out.indexOf('#include <roughnessmap_fragment>'));
    expect(out.indexOf('eyeMask')).toBeLessThan(out.indexOf('#include <metalnessmap_fragment>'));
    // A shader without the chunk is left alone.
    expect(eyeGlossShader('void main() {}')).toBe('void main() {}');
  });

  it('eye_rectangle_holds_the_eyeballs_and_no_skin_on_every_head', async () => {
    const inRect = (u: number, v: number) => u >= EYE_UV.u0 && u <= EYE_UV.u1 && v >= EYE_UV.v0 && v <= EYE_UV.v1;
    for (const entry of manifest.avatars) {
      const g = await parse(entry.glb.slice(1));
      const head = meshes(g).find((m) => partOf((m.material as MeshStandardMaterial).name) === 'skin') as SkinnedMesh;
      expect(head, entry.id).toBeTruthy();
      const geo = head.geometry;
      const uv = geo.getAttribute('uv');
      const si = geo.getAttribute('skinIndex');
      const sw = geo.getAttribute('skinWeight');
      const eyeBones = new Set(head.skeleton.bones.flatMap((b, i) => (/Eye$/.test(b.name) ? [i] : [])));
      expect(eyeBones.size, entry.id).toBe(2);
      let eyes = 0;
      let skinInside = 0;
      for (let v = 0; v < uv.count; v++) {
        let best = 0;
        let bw = -1;
        for (let k = 0; k < si.itemSize; k++) {
          if (sw.getComponent(v, k) > bw) {
            bw = sw.getComponent(v, k);
            best = si.getComponent(v, k);
          }
        }
        const isEye = eyeBones.has(best);
        const inside = inRect(uv.getX(v), uv.getY(v));
        if (isEye) {
          eyes++;
          expect(inside, `${entry.id} eye vertex ${v}`).toBe(true);
        } else if (inside) skinInside++;
      }
      expect(eyes, entry.id).toBeGreaterThan(100);
      // At most a stray vertex at an eye's corner (f01 and f02 have one each, wet in life too).
      expect(skinInside, entry.id).toBeLessThanOrEqual(1);
    }
  });
});
