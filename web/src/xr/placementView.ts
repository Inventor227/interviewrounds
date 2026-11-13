// What the user sees while placing the desk: a ghost sheet floating where it would land, a ring filling around the
// resting fingertip, then the sheet unrolling from the touch point.

import { CanvasTexture, Euler, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Object3D, type Texture } from 'three';
import { fallbackDesk, FINGER_PAD, type DeskPose, type HeadPose, type PlacementStatus } from './placement';
import { SHEET_D, SHEET_TILT, SHEET_W, sheetPoint } from './seats';
import { holdRing } from './ui/style';

const UNROLL_MS = 380;

export class PlacementView {
  readonly group = new Group();
  private readonly ghost: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly ring = holdRing(0.022, '#F4F2EE');
  private unrollStart: number | null = null;
  private target: Object3D | null = null;
  // Reused every frame while placing.
  private readonly touchDesk: DeskPose = { origin: { x: 0, y: 0, z: 0 }, yaw: 0, deskY: 0, source: 'touch' };
  private readonly euler = new Euler(0, 0, 0, 'YXZ');

  constructor() {
    this.group.name = 'placement';
    const g = new PlaneGeometry(SHEET_W, SHEET_D).rotateX(-Math.PI / 2).translate(0, 0, -SHEET_D / 2);
    this.ghost = new Mesh(g, new MeshBasicMaterial({ map: ghostTexture(), color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }));
    this.ghost.name = 'ghost-sheet';
    this.ring.mesh.rotation.x = -Math.PI / 2;
    this.group.add(this.ghost, this.ring.mesh);
  }

  /** Each frame while placing: the ghost hovers at the default spot, or under the resting fingertip. */
  update(head: HeadPose, st: PlacementStatus, nowMs: number): void {
    let desk: DeskPose;
    if (st.tip && st.progress > 0) {
      desk = this.touchDesk;
      desk.origin.x = st.tip.x;
      desk.origin.y = st.tip.y - FINGER_PAD;
      desk.origin.z = st.tip.z;
      desk.deskY = desk.origin.y;
      desk.yaw = head.yaw;
    } else {
      desk = fallbackDesk(head);
    }
    this.poseGhost(desk);
    this.ghost.material.opacity = 0.7 + 0.2 * Math.sin(nowMs / 400) + 0.1 * st.progress;
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
    this.ghost.rotation.copy(this.euler.set(SHEET_TILT, desk.yaw, 0, 'YXZ'));
  }
}

/** A faint paper fill with a clear dashed outline, so the ghost reads over any desk. */
function ghostTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const x = c.getContext('2d');
  if (!x) return null;
  x.fillStyle = 'rgba(244,242,238,0.22)';
  x.fillRect(0, 0, c.width, c.height);
  x.strokeStyle = 'rgba(244,242,238,0.95)';
  x.lineWidth = 4;
  x.setLineDash([14, 10]);
  x.strokeRect(3, 3, c.width - 6, c.height - 6);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
