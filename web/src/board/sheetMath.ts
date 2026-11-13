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

  constructor(private readonly anchor: Object3D) {}

  project(p: Vec3): { x_cm: number; y_cm: number; h_cm: number } {
    this.anchor.updateWorldMatrix(true, false);
    this.inv.copy(this.anchor.matrixWorld).invert();
    return localToBoard(this.v.set(p.x, p.y, p.z).applyMatrix4(this.inv));
  }
}
