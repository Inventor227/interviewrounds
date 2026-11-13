// Small helpers for board meshes on the sheet: canvases, canvas textures, and flat planes
// placed by board cm in the sheet anchor's frame.
import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import type { Rect } from './model';
import { boardToLocal } from './sheetMath';

export type BoardCanvas = HTMLCanvasElement | OffscreenCanvas;
export type MakeCanvas = (w: number, h: number) => BoardCanvas;

export const defaultCanvas: MakeCanvas = (w, h) => {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
};

export function canvasTexture(c: BoardCanvas, mipmaps: boolean): CanvasTexture {
  const t = new CanvasTexture(c as HTMLCanvasElement);
  t.colorSpace = SRGBColorSpace;
  if (!mipmaps) {
    t.generateMipmaps = false;
    t.minFilter = LinearFilter;
  }
  return t;
}

/** A flat plane lying on the sheet surface (the anchor's XZ plane, facing +Y). */
export function sheetPlane(name: string, w: number, h: number, map: CanvasTexture | null, transparent = false): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map, transparent, toneMapped: false, depthWrite: !transparent }));
  m.name = name;
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** Moves and scales a 1 x 1 plane to cover a board rect (cm), lifted `liftCm` above the surface. */
export function placeOnSheet(mesh: Mesh, r: Rect, liftCm: number): void {
  boardToLocal(r.x + r.w / 2, r.y + r.h / 2, liftCm, mesh.position);
  mesh.scale.set(r.w / 100, r.h / 100, 1);
}
