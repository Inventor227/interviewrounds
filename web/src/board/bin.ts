// The bin beside the sheet: drop a card, a stroke or a ghost on it to delete or dismiss it.
// Two textures drawn once (idle and lit); lighting it swaps them, so nothing is redrawn.
import type { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { Kit } from './kits';
import { renderBin } from './render';
import { canvasTexture, defaultCanvas, placeOnSheet, sheetPlane, type MakeCanvas } from './xrmesh';

export class Bin {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly idle: CanvasTexture;
  private readonly lit: CanvasTexture;
  hot = false;

  constructor(kit: Kit, makeCanvas: MakeCanvas = defaultCanvas, pxPerCm = 24) {
    const r = kit.bin;
    const draw = (hot: boolean) => {
      const c = makeCanvas(Math.ceil(r.w * pxPerCm), Math.ceil(r.h * pxPerCm));
      const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
      if (ctx) {
        ctx.translate(-r.x * pxPerCm, -r.y * pxPerCm);
        renderBin(ctx, kit, pxPerCm, hot);
      }
      return canvasTexture(c, true);
    };
    this.idle = draw(false);
    this.lit = draw(true);
    this.mesh = sheetPlane('board-bin', 1, 1, this.idle, true);
    placeOnSheet(this.mesh, r, 0);
  }

  setHot(hot: boolean): void {
    if (hot === this.hot) return;
    this.hot = hot;
    this.mesh.material.map = hot ? this.lit : this.idle;
    this.mesh.material.needsUpdate = true;
  }

  dispose(): void {
    this.idle.dispose();
    this.lit.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
