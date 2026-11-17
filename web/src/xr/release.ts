// Closing a room frees what its renderer holds on objects that outlive it. three's renderer puts a 'dispose' listener
// on every geometry, material and texture it draws, and only that object's dispose() takes the listener off again.
// Objects made once per page (UIKit's panel geometry, three's lookup table for physically based materials) are drawn
// by every round's renderer, so without this each closed round's renderer, canvas and GL context stayed reachable
// from them. Disposing a shared object only frees GPU memory; the next room uploads it again when it draws it.

import type { Material, Object3D, Texture } from 'three';

export interface Disposable {
  dispose(): void;
}

/** The uniforms the renderer compiled a material with (three keeps them in `renderer.properties`). */
export type UniformsOf = (mat: Material) => Record<string, { value?: unknown } | undefined> | undefined;

function addTexture(out: Set<Disposable>, v: unknown): void {
  if (v && typeof v === 'object' && (v as Texture).isTexture) out.add(v as Texture);
}

function addMaterial(out: Set<Disposable>, mat: Material | undefined | null, uniformsOf?: UniformsOf): void {
  if (!mat || out.has(mat)) return;
  out.add(mat);
  for (const v of Object.values(mat as unknown as Record<string, unknown>)) addTexture(out, v);
  // Textures only the renderer puts in: three's own lookup table for physically based materials (one per page) and
  // the environment map.
  let uniforms: ReturnType<UniformsOf>;
  try {
    uniforms = uniformsOf?.(mat);
  } catch {
    uniforms = undefined;
  }
  for (const u of Object.values(uniforms ?? {})) addTexture(out, u?.value);
}

/** Every geometry, material and material texture under the roots, once each. */
export function gpuResourcesOf(roots: readonly Object3D[], uniformsOf?: UniformsOf): Set<Disposable> {
  const out = new Set<Disposable>();
  for (const root of roots) {
    root.traverse((o) => {
      const m = o as Object3D & { geometry?: Disposable; material?: Material | Material[] };
      if (m.geometry && typeof m.geometry.dispose === 'function') out.add(m.geometry);
      if (Array.isArray(m.material)) for (const mat of m.material) addMaterial(out, mat, uniformsOf);
      else addMaterial(out, m.material, uniformsOf);
    });
  }
  return out;
}

/** Disposes each resource; one that throws does not stop the rest. */
export function releaseGpuResources(resources: Iterable<Disposable>): void {
  for (const r of resources) {
    try {
      r.dispose();
    } catch {
      // Already gone with its context.
    }
  }
}
