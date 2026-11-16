// Materials for the converted Rocketbox avatars, tuned to sit in a passthrough room.
//
// The conversion gives every primitive the same plain PBR material (roughness 0.65, no specular map), which makes
// suits shine like vinyl and skin look waxy under the room's IBL. Here, once per loaded model:
// - cloth (the body primitive: suit, shirt, hands) goes matte;
// - skin (the head primitive) a little rougher, except the eyeballs, which get a wet, glossy surface so they catch
//   the key light and the room, the way living eyes do;
// - hair and lashes (the alpha-tested primitive) matte.
// No new textures, draw calls or lights; the eye gloss is a few instructions in the head's fragment shader.

import type { Material, Mesh, MeshStandardMaterial, Object3D } from 'three';

export type AvatarPart = 'cloth' | 'skin' | 'hair' | 'other';

/** Roughness per part (the conversion leaves 0.65 everywhere). */
export const ROUGHNESS: Record<AvatarPart, number | null> = {
  cloth: 0.88,
  skin: 0.6,
  hair: 0.8,
  other: null,
};

/**
 * The eyeballs' rectangle in the head texture's UV space (the same atlas on every converted Rocketbox head): every
 * vertex skinned to an eye bone lies inside it, and of the rest of the head at most one vertex at an eye's corner
 * (pinned by a test on all six avatars).
 */
export const EYE_UV = { u0: 0.2, u1: 0.326, v0: 0.868, v1: 0.996 };
/** Roughness of the eyeballs: wet and glossy, so they show a catchlight. */
export const EYE_ROUGHNESS = 0.12;

/** Which part of the avatar a converted material belongs to, from its name (for example m015_body, f014_opacity). */
export function partOf(materialName: string): AvatarPart {
  if (/_body$/.test(materialName)) return 'cloth';
  if (/_head$/.test(materialName)) return 'skin';
  if (/_opacity$/.test(materialName)) return 'hair';
  return 'other';
}

/** The head's fragment shader with the eye gloss: lower roughness inside the eye rectangle of the texture. */
export function eyeGlossShader(fragmentShader: string): string {
  const hook = '#include <roughnessmap_fragment>';
  if (!fragmentShader.includes(hook)) return fragmentShader;
  const { u0, u1, v0, v1 } = EYE_UV;
  return fragmentShader.replace(
    hook,
    `${hook}
	{
		vec2 eyeUv = vMapUv;
		float eyeMask = step(${f(u0)}, eyeUv.x) * step(eyeUv.x, ${f(u1)}) * step(${f(v0)}, eyeUv.y) * step(eyeUv.y, ${f(v1)});
		roughnessFactor = mix(roughnessFactor, ${f(EYE_ROUGHNESS)}, eyeMask);
	}`,
  );
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Applies the passthrough materials to every mesh of a loaded avatar. Safe to call twice (it runs once). */
export function dressAvatar(model: Object3D): void {
  const seen = new Set<Material>();
  model.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(m) || m.userData.dressed) continue;
      seen.add(m);
      dress(m as MeshStandardMaterial);
    }
  });
}

function dress(m: MeshStandardMaterial): void {
  if (!m.isMeshStandardMaterial) return;
  m.userData.dressed = true;
  const part = partOf(m.name);
  const r = ROUGHNESS[part];
  if (r !== null) m.roughness = r;
  // The eye gloss needs the colour map's UVs (vMapUv), which every converted head has.
  if (part === 'skin' && m.map) {
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = eyeGlossShader(shader.fragmentShader);
    };
    m.customProgramCacheKey = () => 'avatar-eye-gloss';
    m.needsUpdate = true;
  }
}
