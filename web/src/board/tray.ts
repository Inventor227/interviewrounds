// The tray of cards beside the sheet, on the non-dominant side (setting dominant_hand), and
// the bin on the other side. The tray is drawn once; pulling a card is BoardInput's job.
import type { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';
import type { Kit } from './kits';
import { SHEET, type Rect } from './model';
import { renderKit } from './render';
import { canvasTexture, defaultCanvas, placeOnSheet, sheetPlane, type MakeCanvas } from './xrmesh';

const mirror = (r: Rect): Rect => ({ ...r, x: SHEET.w - r.x - r.w });

/**
 * Which hand is the dominant one for this round: the hand that touched the desk to place the sheet (people reach
 * with the hand they write with), else the setting from the 2D pages. The tray goes on the other side.
 */
export function dominantFor(deskHand: 'left' | 'right' | undefined | null, setting: 'left' | 'right' | undefined | null): 'left' | 'right' {
  return deskHand ?? setting ?? 'right';
}

/** The kit for a hand: tray on the non-dominant side, bin on the dominant side. */
export function kitFor(kit: Kit, dominant: 'left' | 'right'): Kit {
  if (dominant === 'right') return kit;
  return {
    ...kit,
    tray: kit.tray.map((s) => ({ ...s, ...mirror(s) })),
    bin: mirror(kit.bin),
    view: mirror(kit.view),
    ...(kit.panel ? { panel: mirror(kit.panel) } : {}),
  };
}

export class Tray {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly texture: CanvasTexture;
  readonly rect: Rect;

  constructor(kit: Kit, makeCanvas: MakeCanvas = defaultCanvas, pxPerCm = 24) {
    const xs = kit.tray.map((s) => s.x);
    const ys = kit.tray.map((s) => s.y);
    const x0 = Math.min(...xs) - 0.5;
    const y0 = Math.min(...ys) - 0.5;
    const x1 = Math.max(...kit.tray.map((s) => s.x + s.w)) + 0.5;
    const y1 = Math.max(...kit.tray.map((s) => s.y + s.h)) + 0.5;
    this.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const c = makeCanvas(Math.ceil(this.rect.w * pxPerCm), Math.ceil(this.rect.h * pxPerCm));
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | null;
    if (ctx) {
      ctx.translate(-x0 * pxPerCm, -y0 * pxPerCm);
      renderKit(ctx, kit, pxPerCm, { bin: false });
    }
    this.texture = canvasTexture(c, true);
    this.mesh = sheetPlane('board-tray', 1, 1, this.texture, true);
    placeOnSheet(this.mesh, this.rect, 0);
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
