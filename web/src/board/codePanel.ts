// The code panel in XR: a standing screen beside the sheet on the dominant side (kit.panel,
// 44 x 34 cm), showing the kit's panel (board.code lines, gutter, trace marker). Like the sheet,
// its texture uploads only when the code changes (or the panel is scrolled, or web fonts
// arrive); a dragged line or the moving trace marker goes on a small gesture mesh in front of it.
import { Group, Object3D, type CanvasTexture, type Mesh, type MeshBasicMaterial, type PlaneGeometry } from 'three';
import type { Board } from '../shared/types';
import type { Overlay } from './input';
import type { Kit } from './kits';
import type { Rect } from './model';
import { fontsEpoch } from './render';
import { panelToLocal, placePanelFrame } from './sheetMath';
import { canvasTexture, defaultCanvas, sheetPlane, type BoardCanvas, type MakeCanvas } from './xrmesh';

export const PANEL_PX_PER_CM = 24;
const GESTURE_PX_PER_CM = 24;
const pow2 = (n: number) => Math.min(1024, Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, n)))));

export class CodePanel {
  /** The panel's surface frame (child of the sheet anchor): what hands are projected onto. */
  readonly frame = new Object3D();
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly gestureMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly texture: CanvasTexture;
  readonly stats = { uploads: 0, gestureUploads: 0 };
  private readonly canvas: BoardCanvas;
  private readonly rect: Rect;
  private lastCode: Board['code'] | undefined = undefined;
  private lastKey = '';
  private g: { canvas: BoardCanvas; tex: CanvasTexture } | null = null;
  private gKey = '';

  constructor(
    private readonly kit: Kit,
    side: 'left' | 'right',
    private readonly makeCanvas: MakeCanvas = defaultCanvas,
  ) {
    if (!kit.panel || !kit.renderPanel) throw new Error('This kit has no code panel.');
    this.rect = kit.panel;
    this.frame.name = 'code-panel';
    placePanelFrame(this.frame, side, this.rect.w / 100);
    this.canvas = this.makeCanvas(Math.round(this.rect.w * PANEL_PX_PER_CM), Math.round(this.rect.h * PANEL_PX_PER_CM));
    this.texture = canvasTexture(this.canvas, true);
    this.mesh = sheetPlane('code-panel-screen', this.rect.w / 100, this.rect.h / 100, this.texture);
    panelToLocal(this.rect, this.rect.x + this.rect.w / 2, this.rect.y + this.rect.h / 2, 0, this.mesh.position);
    this.gestureMesh = sheetPlane('code-panel-gesture', 1, 1, null, true);
    this.gestureMesh.renderOrder = 1;
    this.gestureMesh.visible = false;
    const body = new Group();
    body.add(this.mesh, this.gestureMesh);
    this.frame.add(body);
  }

  /** Call every frame: redraws the screen when the code changed, the gesture strip when it moved. */
  update(board: Board, overlays: Overlay[]): void {
    const key = `${this.kit.panelKey?.(board) ?? ''}|${fontsEpoch()}`;
    if (board.code !== this.lastCode || key !== this.lastKey) {
      this.lastCode = board.code;
      this.lastKey = key;
      const ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D | null;
      if (ctx) {
        const k = PANEL_PX_PER_CM;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.translate(-this.rect.x * k, -this.rect.y * k);
        this.kit.renderPanel!(ctx, board, k);
      }
      this.texture.needsUpdate = true;
      this.stats.uploads += 1;
    }
    const mine = overlays.filter((o): o is Extract<Overlay, { kind: 'kit' }> => o.kind === 'kit' && o.draw.surface === 'panel');
    const gKey = mine.map((o) => o.draw.key).join('|');
    if (gKey === this.gKey) return;
    this.gKey = gKey;
    if (!mine.length) {
      this.gestureMesh.visible = false;
      return;
    }
    const rs = mine.map((o) => o.draw.bounds);
    const x0 = Math.min(...rs.map((r) => r.x)) - 0.5;
    const y0 = Math.min(...rs.map((r) => r.y)) - 0.5;
    const x1 = Math.max(...rs.map((r) => r.x + r.w)) + 0.5;
    const y1 = Math.max(...rs.map((r) => r.y + r.h)) + 0.5;
    const ppc = Math.min(GESTURE_PX_PER_CM, 1024 / Math.max(x1 - x0, y1 - y0));
    const wPx = pow2((x1 - x0) * ppc);
    const hPx = pow2((y1 - y0) * ppc);
    if (!this.g || this.g.canvas.width !== wPx || this.g.canvas.height !== hPx) {
      this.g?.tex.dispose();
      const canvas = this.makeCanvas(wPx, hPx);
      this.g = { canvas, tex: canvasTexture(canvas, false) };
      this.gestureMesh.material.map = this.g.tex;
      this.gestureMesh.material.needsUpdate = true;
    }
    const ctx = this.g.canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, wPx, hPx);
      ctx.translate(-x0 * ppc, -y0 * ppc);
      for (const o of mine) o.draw.draw(ctx, board, ppc);
    }
    const w = wPx / ppc;
    const h = hPx / ppc;
    panelToLocal(this.rect, x0 + w / 2, y0 + h / 2, 0.3, this.gestureMesh.position);
    this.gestureMesh.scale.set(w / 100, h / 100, 1);
    this.gestureMesh.visible = true;
    this.g.tex.needsUpdate = true;
    this.stats.gestureUploads += 1;
  }

  dispose(): void {
    this.texture.dispose();
    this.g?.tex.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.gestureMesh.geometry.dispose();
    this.gestureMesh.material.dispose();
  }
}
