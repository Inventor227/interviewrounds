import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Scene, Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { gpuResourcesOf, releaseGpuResources } from './release';

describe('releasing a closed room', () => {
  it("fires dispose on module-level shared geometry, so no closed renderer stays registered on it", () => {
    // UIKit draws every panel with one module-level PlaneGeometry. Each renderer that draws it adds a 'dispose'
    // listener holding that renderer (and its canvas); only geometry.dispose() takes the listeners off again.
    const shared = new PlaneGeometry();
    // As three's renderer does it: the listener frees the renderer's buffers and takes itself off.
    const rendererListener = () => shared.removeEventListener('dispose', rendererListener);
    shared.addEventListener('dispose', rendererListener);
    const scene = new Scene();
    const panel = new Group();
    panel.add(new Mesh(shared, new MeshStandardMaterial()), new Mesh(shared, new MeshStandardMaterial()));
    scene.add(panel);
    const fired: string[] = [];
    shared.addEventListener('dispose', () => fired.push('geometry'));

    releaseGpuResources(gpuResourcesOf([scene]));

    expect(fired).toEqual(['geometry']); // once, however many meshes share it
    expect(shared.hasEventListener('dispose', rendererListener)).toBe(false);
  });

  it('collects geometry, materials and their textures once each, from every root', () => {
    const tex = new Texture();
    const mat = new MeshStandardMaterial({ map: tex });
    const geo = new BoxGeometry();
    const a = new Group();
    a.add(new Mesh(geo, mat));
    const b = new Group();
    b.add(new Mesh(geo, [mat, new MeshStandardMaterial()]));
    const found = gpuResourcesOf([a, b, a]);
    expect(found.has(geo)).toBe(true);
    expect(found.has(mat)).toBe(true);
    expect(found.has(tex)).toBe(true);
    expect(found.size).toBe(4);
  });

  it("also takes the textures the renderer added to a material's compiled uniforms", () => {
    const lut = new Texture(); // like three's DFG lookup table: in the program's uniforms, never on the material
    const mat = new MeshStandardMaterial();
    const g = new Group();
    g.add(new Mesh(new BoxGeometry(), mat));
    const found = gpuResourcesOf([g], (m) => (m === mat ? { dfgLUT: { value: lut }, roughness: { value: 0.5 } } : undefined));
    expect(found.has(lut)).toBe(true);
    expect(gpuResourcesOf([g], () => { throw new Error('no properties'); }).has(mat)).toBe(true);
  });

  it('keeps going when one resource throws on dispose', () => {
    const bad = { dispose: () => { throw new Error('gone'); } };
    let disposed = 0;
    const good = { dispose: () => void disposed++ };
    expect(() => releaseGpuResources(new Set([bad, good]))).not.toThrow();
    expect(disposed).toBe(1);
  });
});
