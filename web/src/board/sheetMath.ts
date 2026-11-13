// The sheet in 3D: a 64 x 40 cm plane on the desk, near edge 2 cm above the desk top, tilted
// 15 degrees with the far edge up (research 06 §2.1; same frame as web/src/xr sheetPoint).
// Board cm (origin top-left = far-left corner, x right, y toward the user) map to the sheet
// anchor's local frame: origin near edge centre, +X right, -Z toward the far edge, +Y normal.
import { Euler, Matrix4, type Object3D, Vector3 } from 'three';
import { SHEET } from './model';
import type { DeskPose, Vec3 } from './port';

export const SHEET_TILT = (15 * Math.PI) / 180;
/** Height of the sheet's near edge above the desk top (m). */
export const SHEET_LIFT = 0.02;

/** Puts a sheet anchor on a desk pose (what Room.place does for its sheetAnchor). */
export function placeAnchor(anchor: Object3D, desk: DeskPose): void {
  anchor.position.set(desk.origin.x, desk.deskY + SHEET_LIFT, desk.origin.z);
  anchor.rotation.copy(new Euler(SHEET_TILT, desk.yaw, 0, 'YXZ'));
  anchor.updateMatrixWorld(true);
}

/** Board cm (+ height above the surface in cm) to the anchor's local frame (m). */
export function boardToLocal(xCm: number, yCm: number, hCm = 0, out = new Vector3()): Vector3 {
  return out.set((xCm - SHEET.w / 2) / 100, hCm / 100, -(SHEET.h - yCm) / 100);
}

/** The anchor's local frame (m) to board cm and height above the surface (cm). */
export function localToBoard(v: Vector3): { x_cm: number; y_cm: number; h_cm: number } {
  return { x_cm: v.x * 100 + SHEET.w / 2, y_cm: SHEET.h + v.z * 100, h_cm: v.y * 100 };
}

/** A board point in world space (the space of the anchor's parent chain). */
export function sheetToWorld(anchor: Object3D, xCm: number, yCm: number, hCm = 0): Vec3 {
  anchor.updateWorldMatrix(true, false);
  const v = boardToLocal(xCm, yCm, hCm).applyMatrix4(anchor.matrixWorld);
  return { x: v.x, y: v.y, z: v.z };
}

/** Projects world points onto the sheet: board cm plus height above the surface. */
export class SheetProjector {
  private readonly inv = new Matrix4();
  private readonly v = new Vector3();

  constructor(readonly anchor: Object3D) {}

  project(p: Vec3): { x_cm: number; y_cm: number; h_cm: number } {
    this.anchor.updateWorldMatrix(true, false);
    this.inv.copy(this.anchor.matrixWorld).invert();
    return localToBoard(this.v.set(p.x, p.y, p.z).applyMatrix4(this.inv));
  }
}

/** How the code panel stands: tilted back 15 degrees from upright, yawed 25 degrees toward the user. */
export const PANEL_TILT = (75 * Math.PI) / 180;
export const PANEL_YAW = (25 * Math.PI) / 180;

/**
 * Puts the code panel's frame under the sheet anchor: its bottom edge on the desk beside the
 * sheet (on `side`), standing like a laptop screen and turned toward the user. The frame has
 * the sheet's convention: origin at the bottom edge centre, +X right, -Z up the panel, +Y the
 * screen's normal (toward the user).
 */
export function placePanelFrame(frame: Object3D, side: 'left' | 'right', panelWidthM = 0.4): void {
  const s = side === 'right' ? 1 : -1;
  // In the desk frame (yaw only), relative to the sheet's near edge centre (the anchor origin).
  const halfSheet = SHEET.w / 200;
  const offset = new Vector3(s * (halfSheet + 0.04 + (panelWidthM / 2) * Math.cos(PANEL_YAW)), -SHEET_LIFT + 0.01, -0.12);
  const untilt = new Matrix4().makeRotationX(-SHEET_TILT);
  frame.position.copy(offset.applyMatrix4(untilt));
  const q = new Matrix4()
    .makeRotationX(-SHEET_TILT)
    .multiply(new Matrix4().makeRotationY(-s * PANEL_YAW))
    .multiply(new Matrix4().makeRotationX(PANEL_TILT));
  frame.quaternion.setFromRotationMatrix(q);
  frame.updateMatrixWorld(true);
}

/** A point on the panel: its rect in board cm (x, y from its top-left) to the panel frame (m). */
export function panelToLocal(panel: { x: number; y: number; w: number; h: number }, xCm: number, yCm: number, hCm = 0, out = new Vector3()): Vector3 {
  return out.set((xCm - panel.x - panel.w / 2) / 100, hCm / 100, -(panel.y + panel.h - yCm) / 100);
}

/**
 * Projects onto the sheet, or onto the code panel when the hand is at the panel (inside its
 * area and closer to its screen than to the sheet). Both give board cm: the panel maps to its
 * region beside the sheet (kit.panel).
 */
export class SurfaceProjector {
  private readonly sheet: SheetProjector;
  private readonly inv = new Matrix4();
  private readonly v = new Vector3();
  private readonly d = new Vector3();

  constructor(
    anchor: Object3D,
    private readonly panel?: { frame: Object3D; rect: { x: number; y: number; w: number; h: number } },
  ) {
    this.sheet = new SheetProjector(anchor);
  }

  project(p: Vec3): { x_cm: number; y_cm: number; h_cm: number } {
    const onSheet = this.sheet.project(p);
    if (!this.panel) return onSheet;
    const { frame, rect } = this.panel;
    frame.updateWorldMatrix(true, false);
    this.inv.copy(frame.matrixWorld).invert();
    const l = this.v.set(p.x, p.y, p.z).applyMatrix4(this.inv);
    const onPanel = { x_cm: rect.x + rect.w / 2 + l.x * 100, y_cm: rect.y + rect.h + l.z * 100, h_cm: l.y * 100 };
    const m = 3;
    const inPanel = onPanel.x_cm >= rect.x - m && onPanel.x_cm <= rect.x + rect.w + m && onPanel.y_cm >= rect.y - m && onPanel.y_cm <= rect.y + rect.h + m && onPanel.h_cm > -3 && onPanel.h_cm < 12;
    if (!inPanel) return onSheet;
    const sheetValid = onSheet.h_cm > -3 && onSheet.h_cm < 12 && onSheet.x_cm >= -3 && onSheet.x_cm <= SHEET.w + 3;
    return sheetValid && Math.abs(onSheet.h_cm) < Math.abs(onPanel.h_cm) ? onSheet : onPanel;
  }

  /**
   * Where an aim ray (a controller's) meets the board from the front: the code panel when the ray lands on its
   * screen, else the sheet's plane (the sheet, the tray and the bin lie in it). The world point and the distance
   * along the ray (m); null when the ray points away or comes from behind.
   */
  cast(origin: Vec3, dir: Vec3): { point: Vec3; dist: number } | null {
    const anchor = this.sheet.anchor;
    anchor.updateWorldMatrix(true, false);
    let best: { point: Vec3; dist: number } | null = null;
    if (this.panel) {
      const { frame, rect } = this.panel;
      frame.updateWorldMatrix(true, false);
      const hit = castPlane(frame, this.inv, origin, dir, this.v, this.d);
      if (hit) {
        const x = rect.x + rect.w / 2 + hit.local.x * 100;
        const y = rect.y + rect.h + hit.local.z * 100;
        const m = 1;
        if (x >= rect.x - m && x <= rect.x + rect.w + m && y >= rect.y - m && y <= rect.y + rect.h + m) best = { point: hit.point, dist: hit.dist };
      }
    }
    const hit = castPlane(anchor, this.inv, origin, dir, this.v, this.d);
    if (hit && (!best || hit.dist < best.dist)) {
      const b = localToBoard(hit.local);
      // The panel's place in board cm is beside the sheet; the desk under it is not the board.
      const r = this.panel?.rect;
      const underPanel = !!r && b.x_cm >= r.x && b.x_cm <= r.x + r.w && b.y_cm >= r.y && b.y_cm <= r.y + r.h;
      if (!underPanel) best = { point: hit.point, dist: hit.dist };
    }
    return best;
  }
}

/** A ray against a frame's surface (its local y = 0 plane), from the front (+Y) side only. */
function castPlane(frame: Object3D, inv: Matrix4, origin: Vec3, dir: Vec3, v: Vector3, d: Vector3): { point: Vec3; dist: number; local: Vector3 } | null {
  inv.copy(frame.matrixWorld).invert();
  v.set(origin.x, origin.y, origin.z).applyMatrix4(inv);
  d.set(dir.x, dir.y, dir.z).transformDirection(inv);
  if (!(v.y > 0) || !(d.y < -1e-4)) return null;
  const t = -v.y / d.y;
  const local = new Vector3(v.x + d.x * t, 0, v.z + d.z * t);
  const w = local.clone().applyMatrix4(frame.matrixWorld);
  return { point: { x: w.x, y: w.y, z: w.z }, dist: t, local };
}
