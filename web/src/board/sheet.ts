// The sheet in XR: a 64 x 40 cm board on the desk (under the sheet anchor). Two meshes:
// - the board texture (2048 x 1280, 32 px/cm), redrawn and uploaded only when the committed
//   board changes; it is also the texture the wall whiteboard mirrors;
// - a small gesture mesh just above it for what moves every frame (the live stroke, the
//   dragged card, the connector, a tray card, ghost settle rings), sized to what is live so
//   each frame uploads a small texture;
// - texture-free meshes for what follows the hands: a ring per hand (the pinch shadow) and
//   an outline per hovered card, so hovering never uploads anything.
// Plus the tray and the bin beside the sheet.
import {
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Path,
  RingGeometry,
  Shape,
  ShapeGeometry,
  type CanvasTexture,
  type PlaneGeometry,
} from 'three';
import type { Board } from '../shared/types';
import { Bin } from './bin';
import type { GhostRing } from './ghosts';
import type { HandPointer } from './hand';
import type { Overlay } from './input';
import type { Kit } from './kits';
import { findItem, itemRect, SHEET, type Rect } from './model';
import { ACCENT, BoardView, overlayBounds, overlayKey, renderGhostRing, renderOverlay, ringKey } from './render';
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
  /** Hovered cards (one per idle hand), outlined without touching the board texture. */
  hovers?: string[];
  overlays?: Overlay[];
  rings?: GhostRing[];
  pointers?: HandPointer[];
}

export interface SheetOptions {
  kit: Kit;
  makeCanvas?: MakeCanvas;
}

/** A rounded rectangle centred on the origin (cm). */
function roundedRect(target: Shape | Path, w: number, h: number, r: number): void {
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2, h / 2);
  target.moveTo(x + rr, y);
  target.lineTo(x + w - rr, y);
  target.quadraticCurveTo(x + w, y, x + w, y + rr);
  target.lineTo(x + w, y + h - rr);
  target.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  target.lineTo(x + rr, y + h);
  target.quadraticCurveTo(x, y + h, x, y + h - rr);
  target.lineTo(x, y + rr);
  target.quadraticCurveTo(x, y, x + rr, y);
}

/** A rounded outline around a w x h card (cm): a ring from `inset` to `outset` outside it. */
function outlineGeometry(w: number, h: number, outset: number, width: number): ShapeGeometry {
  const outer = new Shape();
  roundedRect(outer, w + 2 * outset, h + 2 * outset, 0.6 + outset);
  const hole = new Path();
  roundedRect(hole, w + 2 * (outset - width), h + 2 * (outset - width), 0.6 + outset - width);
  outer.holes.push(hole);
  return new ShapeGeometry(outer, 6);
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
  private readonly shadows: Record<'left' | 'right', Mesh<RingGeometry, MeshBasicMaterial>>;
  private readonly hoverPool: { mesh: Mesh<ShapeGeometry, MeshBasicMaterial>; key: string }[] = [];

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
      // The kit's fixed parts (lanes, agenda, slots) are part of the board texture; the tray and
      // bin are their own meshes, and the code panel stands on its own.
      decor: this.kit,
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

    // Pinch shadows: a unit ring per hand (scaled in cm), with a disc that shows while pinched.
    const shadow = () => {
      const m = new Mesh(new RingGeometry(0.82, 1, 40), new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }));
      const disc = new Mesh(new CircleGeometry(0.82, 32), new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }));
      disc.name = 'pinched';
      m.add(disc);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 2;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    this.shadows = { left: shadow(), right: shadow() };
    this.shadows.left.name = 'pinch-shadow-left';
    this.shadows.right.name = 'pinch-shadow-right';
  }

  /** The pinch shadow mesh of a hand. */
  shadow(hand: 'left' | 'right'): Mesh {
    return this.shadows[hand];
  }

  /** Hover outline meshes (some may be hidden). */
  hoverOutlines(): Mesh[] {
    return this.hoverPool.map((h) => h.mesh);
  }

  /** Call every frame; uploads only what changed. */
  update(board: Board, st: SheetState): void {
    // Gestures on the code panel are drawn by the panel, not on the sheet.
    const overlays = (st.overlays ?? []).filter((o) => !(o.kind === 'kit' && o.draw.surface === 'panel'));
    if (this.view.draw(board, { highlight: null, overlays, drawLive: false })) {
      this.texture.needsUpdate = true;
      this.stats.boardUploads += 1;
    }
    this.bin.setHot(overlays.some((o) => (o.kind === 'drag' || o.kind === 'tray') && o.overBin));
    this.drawGesture(board, overlays, st.rings ?? []);
    this.placeShadows(st.pointers ?? []);
    this.placeHovers(board, st.hovers ?? [], overlays);
  }

  private placeShadows(pointers: HandPointer[]): void {
    for (const hand of ['left', 'right'] as const) {
      const m = this.shadows[hand];
      const p = pointers.find((q) => q.hand === hand);
      m.visible = !!p;
      if (!p) continue;
      // The ring tightens as the hand comes down (research 06 §2.5).
      const r = 0.45 + Math.min(Math.max(p.h_cm, 0), 8) * 0.1;
      boardToLocal(p.x_cm, p.y_cm, 0.25, m.position);
      m.scale.setScalar(r / 100);
      m.getObjectByName('pinched')!.visible = p.pinched;
    }
  }

  private placeHovers(board: Board, hovers: string[], overlays: Overlay[]): void {
    const dragged = new Set(overlays.flatMap((o) => (o.kind === 'drag' ? [o.id] : [])));
    const items = hovers.map((id) => findItem(board, id)).filter((it): it is NonNullable<typeof it> => !!it && !dragged.has(it.id) && it.kind !== 'ink');
    items.forEach((it, i) => {
      const r = itemRect(it);
      let slot = this.hoverPool[i];
      if (!slot) {
        const mesh = new Mesh(new ShapeGeometry(new Shape()), new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
        mesh.name = 'hover-outline';
        mesh.rotation.x = -Math.PI / 2;
        mesh.renderOrder = 1;
        this.group.add(mesh);
        slot = { mesh, key: '' };
        this.hoverPool.push(slot);
      }
      // Geometry only changes with the card's size.
      const key = `${r.w}x${r.h}`;
      if (slot.key !== key) {
        slot.mesh.geometry.dispose();
        slot.mesh.geometry = outlineGeometry(r.w, r.h, 0.65, 0.35);
        slot.key = key;
      }
      boardToLocal(r.x + r.w / 2, r.y + r.h / 2, 0.15, slot.mesh.position);
      slot.mesh.scale.setScalar(0.01);
      slot.mesh.visible = true;
    });
    for (let i = items.length; i < this.hoverPool.length; i++) this.hoverPool[i]!.mesh.visible = false;
  }

  /** Current gesture texture size in px (0 x 0 before the first gesture). */
  gestureCanvasSize(): { w: number; h: number } {
    return this.g ? { w: this.g.canvas.width, h: this.g.canvas.height } : { w: 0, h: 0 };
  }

  private drawGesture(board: Board, overlays: Overlay[], rings: GhostRing[]): void {
    const key = `${board.rev}|${overlays.map(overlayKey).join('|')}|${ringKey(rings)}`;
    if (key === this.gKey) return;
    this.gKey = key;

    const rects: Rect[] = [];
    for (const o of overlays) {
      const r = overlayBounds(board, o, this.kit);
      if (r) rects.push(r);
    }
    for (const r of rings) rects.push({ x: r.x - 1.2, y: r.y - 1.2, w: 2.4, h: 2.4 });
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
    for (const m of [...Object.values(this.shadows), ...this.hoverPool.map((h) => h.mesh)]) {
      m.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          (o.material as MeshBasicMaterial).dispose();
        }
      });
    }
  }
}
