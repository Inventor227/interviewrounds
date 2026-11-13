// The sheet in XR: a 64 x 40 cm board on the desk (under the sheet anchor). Two meshes:
// - the board texture (2048 x 1280, 32 px/cm), redrawn and uploaded only when the committed
//   board changes; it is also the texture the wall whiteboard mirrors;
// - a small gesture mesh just above it for what moves every frame (the live stroke, the
//   dragged card, the connector, a tray card, ghost settle rings, the pinch shadow), sized
//   to what is live so each frame uploads a small texture.
// Plus the tray and the bin beside the sheet.
import { Group, type CanvasTexture, type Mesh, type MeshBasicMaterial, type PlaneGeometry } from 'three';
import type { Board } from '../shared/types';
import { Bin } from './bin';
import type { GhostRing } from './ghosts';
import type { HandPointer } from './hand';
import type { Overlay } from './input';
import type { Kit } from './kits';
import { SHEET, type Rect } from './model';
import { BoardView, overlayBounds, overlayKey, renderGhostRing, renderOverlay, renderPinchShadow, ringKey } from './render';
import { boardToLocal } from './sheetMath';
import { Tray } from './tray';
import { canvasTexture, defaultCanvas, placeOnSheet, sheetPlane, type BoardCanvas, type MakeCanvas } from './xrmesh';

export const SHEET_PX_PER_CM = 32;
export const SHEET_CANVAS = { w: SHEET.w * SHEET_PX_PER_CM, h: SHEET.h * SHEET_PX_PER_CM } as const;
/** Gesture mesh resolution and its largest texture side. */
const GESTURE_PX_PER_CM = 24;
const GESTURE_MAX_PX = 1024;
/** The gesture mesh floats this far above the sheet (cm), so it never z-fights. */
const GESTURE_LIFT_CM = 0.3;

export interface SheetState {
  highlight?: string | null;
  overlays?: Overlay[];
  rings?: GhostRing[];
  pointers?: HandPointer[];
}

export interface SheetOptions {
  kit: Kit;
  makeCanvas?: MakeCanvas;
}

const pow2 = (n: number) => Math.min(GESTURE_MAX_PX, Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, n)))));

export class Sheet {
  readonly group = new Group();
  readonly boardMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly gestureMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  /** The committed board; the wall board shows the same texture. */
  readonly texture: CanvasTexture;
  readonly tray: Tray;
  readonly bin: Bin;
  readonly stats = { boardUploads: 0, gestureUploads: 0 };
  private readonly view: BoardView;
  private readonly kit: Kit;
  private readonly makeCanvas: MakeCanvas;
  private g: { canvas: BoardCanvas; tex: CanvasTexture; key: string } | null = null;
  private gKey = '';

  constructor(opts: SheetOptions) {
    this.kit = opts.kit;
    this.makeCanvas = opts.makeCanvas ?? defaultCanvas;
    this.group.name = 'board-sheet';
    const canvas = this.makeCanvas(SHEET_CANVAS.w, SHEET_CANVAS.h) as HTMLCanvasElement;
    this.view = new BoardView(canvas, {
      pxPerCm: SHEET_PX_PER_CM,
      originCm: { x: 0, y: 0 },
      widthCm: SHEET.w,
      heightCm: SHEET.h,
      kit: null,
      layerFactory: (w, h) => this.makeCanvas(w, h),
    });
    this.texture = canvasTexture(canvas, true);
    this.boardMesh = sheetPlane('board-surface', SHEET.w / 100, SHEET.h / 100, this.texture);
    boardToLocal(SHEET.w / 2, SHEET.h / 2, 0, this.boardMesh.position);
    this.gestureMesh = sheetPlane('board-gesture', 1, 1, null, true);
    this.gestureMesh.renderOrder = 1;
    this.gestureMesh.visible = false;
    this.tray = new Tray(this.kit, this.makeCanvas);
    this.bin = new Bin(this.kit, this.makeCanvas);
    this.group.add(this.boardMesh, this.gestureMesh, this.tray.mesh, this.bin.mesh);
  }

  /** Call every frame; uploads only what changed. */
  update(board: Board, st: SheetState): void {
    const overlays = st.overlays ?? [];
    if (this.view.draw(board, { highlight: st.highlight ?? null, overlays, drawLive: false })) {
      this.texture.needsUpdate = true;
      this.stats.boardUploads += 1;
    }
    this.bin.setHot(overlays.some((o) => (o.kind === 'drag' || o.kind === 'tray') && o.overBin));
    this.drawGesture(board, overlays, st.rings ?? [], st.pointers ?? []);
  }

  /** Current gesture texture size in px (0 x 0 before the first gesture). */
  gestureCanvasSize(): { w: number; h: number } {
    return this.g ? { w: this.g.canvas.width, h: this.g.canvas.height } : { w: 0, h: 0 };
  }

  private drawGesture(board: Board, overlays: Overlay[], rings: GhostRing[], pointers: HandPointer[]): void {
    const q = (v: number) => Math.round(v * 5) / 5;
    const key = `${board.rev}|${overlays.map(overlayKey).join('|')}|${ringKey(rings)}|${pointers.map((p) => `${p.hand}:${q(p.x_cm)}:${q(p.y_cm)}:${q(p.h_cm)}:${p.pinched}`).join(',')}`;
    if (key === this.gKey) return;
    this.gKey = key;

    const rects: Rect[] = [];
    for (const o of overlays) {
      const r = overlayBounds(board, o, this.kit);
      if (r) rects.push(r);
    }
    for (const r of rings) rects.push({ x: r.x - 1.2, y: r.y - 1.2, w: 2.4, h: 2.4 });
    for (const p of pointers) rects.push({ x: p.x_cm - 1.5, y: p.y_cm - 1.5, w: 3, h: 3 });
    if (!rects.length) {
      this.gestureMesh.visible = false;
      return;
    }
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    const x1 = Math.max(...rects.map((r) => r.x + r.w));
    const y1 = Math.max(...rects.map((r) => r.y + r.h));
    const ppc = Math.min(GESTURE_PX_PER_CM, GESTURE_MAX_PX / Math.max(x1 - x0, y1 - y0));
    const wPx = pow2((x1 - x0) * ppc);
    const hPx = pow2((y1 - y0) * ppc);

    if (!this.g || this.g.canvas.width !== wPx || this.g.canvas.height !== hPx) {
      this.g?.tex.dispose();
      const canvas = this.makeCanvas(wPx, hPx);
      const tex = canvasTexture(canvas, false);
      this.g = { canvas, tex, key: '' };
      this.gestureMesh.material.map = tex;
      this.gestureMesh.material.needsUpdate = true;
    }
    const ctx = this.g.canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, wPx, hPx);
      ctx.translate(-x0 * ppc, -y0 * ppc);
      for (const p of pointers) renderPinchShadow(ctx, p, ppc);
      for (const o of overlays) renderOverlay(ctx, board, o, this.kit, ppc);
      for (const r of rings) renderGhostRing(ctx, r, ppc);
    }
    placeOnSheet(this.gestureMesh, { x: x0, y: y0, w: wPx / ppc, h: hPx / ppc }, GESTURE_LIFT_CM);
    this.gestureMesh.visible = true;
    this.g.tex.needsUpdate = true;
    this.stats.gestureUploads += 1;
  }

  dispose(): void {
    this.texture.dispose();
    this.g?.tex.dispose();
    this.boardMesh.geometry.dispose();
    this.boardMesh.material.dispose();
    this.gestureMesh.geometry.dispose();
    this.gestureMesh.material.dispose();
    this.tray.dispose();
    this.bin.dispose();
  }
}
