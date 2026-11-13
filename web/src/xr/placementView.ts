// What the user sees while placing the desk: a ghost sheet floating where it would land, a ring filling around the
// resting fingertip, then the sheet unrolling from the touch point.

import { Euler, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Object3D } from 'three';
import { fallbackDesk, type DeskPose, type HeadPose, type PlacementStatus } from './placement';
import { SHEET_D, SHEET_TILT, SHEET_W, sheetPoint } from './seats';
import { holdRing } from './ui/style';

const UNROLL_MS = 380;

export class PlacementView {
  readonly group = new Group();
  private readonly ghost: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly ring = holdRing(0.022, '#F4F2EE');
  private unrollStart: number | null = null;
  private target: Object3D | null = null;

  constructor() {
    this.group.name = 'placement';
    const g = new PlaneGeometry(SHEET_W, SHEET_D).rotateX(-Math.PI / 2).translate(0, 0, -SHEET_D / 2);
    this.ghost = new Mesh(g, new MeshBasicMaterial({ color: 0xf4f2ee, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false }));
    this.ghost.name = 'ghost-sheet';
    this.ring.mesh.rotation.x = -Math.PI / 2;
    this.group.add(this.ghost, this.ring.mesh);
  }

  /** Each frame while placing: the ghost hovers at the default spot, or under the resting fingertip. */
  update(head: HeadPose, st: PlacementStatus, nowMs: number): void {
    const desk: DeskPose =
      st.tip && st.progress > 0 ? { origin: { x: st.tip.x, y: st.tip.y - 0.008, z: st.tip.z }, yaw: head.yaw, deskY: st.tip.y - 0.008, source: 'touch' } : fallbackDesk(head);
    this.poseGhost(desk);
    this.ghost.material.opacity = 0.16 + 0.08 * Math.sin(nowMs / 400) + 0.3 * st.progress;
    if (st.tip && st.progress > 0) {
      this.ring.mesh.position.set(st.tip.x, st.tip.y - 0.004, st.tip.z);
      this.ring.set(st.progress);
    } else {
      this.ring.set(0);
    }
  }

  /** Placement done: unroll the real sheet (the room's sheet frame) from the near edge, then hide the ghost. */
  finish(sheet: Object3D, nowMs: number): void {
    this.ghost.visible = false;
    this.ring.set(0);
    this.target = sheet;
    this.unrollStart = nowMs;
    sheet.scale.set(1, 1, 0.001);
  }

  /** Drives the unroll; returns true while animating. */
  animate(nowMs: number): boolean {
    if (this.unrollStart === null || !this.target) return false;
    const t = Math.min(1, (nowMs - this.unrollStart) / UNROLL_MS);
    const e = 1 - Math.pow(1 - t, 3);
    this.target.scale.set(1, 1, Math.max(0.001, e));
    if (t >= 1) {
      this.unrollStart = null;
      this.group.visible = false;
      return false;
    }
    return true;
  }

  reset(): void {
    this.ghost.visible = true;
    this.group.visible = true;
    this.unrollStart = null;
  }

  private poseGhost(desk: DeskPose): void {
    const p = sheetPoint(desk, 0, 0, 0);
    this.ghost.position.set(p.x, p.y, p.z);
    this.ghost.rotation.copy(new Euler(SHEET_TILT, desk.yaw, 0, 'YXZ'));
  }
}
