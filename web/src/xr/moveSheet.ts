// Moving the sheet after it is placed: pinch (or pull the trigger) on the grab bar below the sheet's near-left
// corner and hold still for half a second; the bar's ring fills, then the sheet and the room follow the hand until
// it lets go. A quick pinch or one that slides away does nothing, so a hand passing by never moves the desk. This
// is how a desk that was set up without a real one ("No desk? We set one up for you.") gets to where the user
// wants it, and it works the same with a hand, a controller's tip or a controller's ray.
//
// Pure logic and the bar's mesh; the world feeds pointers and applies the move.

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Texture } from 'three';
import type { Vec3 } from './math';
import { DWELL_BELOW_HEAD, DWELL_MAX_BELOW_HEAD, type DeskPose } from './placement';
import { SHEET_W } from './seats';
import { holdRing } from './ui/style';

export const MOVE_HOLD_MS = 500;
/** The hold must stay within this of where it started (m). */
export const MOVE_STILL_M = 0.02;

/**
 * The grab bar in the sheet frame (m): x to the right of the near edge centre, z toward the user from the near
 * edge. Below the near-left corner, clear of the round bar (which lies below the near-right) and of the tray.
 */
export const MOVE_BAR = { x: -SHEET_W / 2 + 0.085, z: 0.03, w: 0.13, d: 0.03 } as const;
/** A press counts this far outside the bar (Meta: targets of at least 22 mm, with room around). */
const BAR_MARGIN = 0.012;
/** A hand or a controller tip grabs the bar from at most this far above it, or a little below. */
const BAR_ABOVE = 0.1;
const BAR_BELOW = 0.035;

/** True when a point in the sheet frame (m; y is the height above the sheet's plane) is on the grab bar. */
export function onMoveBar(local: Vec3, touching = true): boolean {
  const b = MOVE_BAR;
  if (Math.abs(local.x - b.x) > b.w / 2 + BAR_MARGIN || Math.abs(local.z - b.z) > b.d / 2 + BAR_MARGIN) return false;
  return !touching || (local.y <= BAR_ABOVE && local.y >= -BAR_BELOW);
}

export type MoveState = 'idle' | 'arming' | 'moving';

export interface MoveStatus {
  state: MoveState;
  /** 0..1 while the hold fills. */
  progress: number;
  /** How far the sheet has been carried from where it was (m). */
  offset: Vec3;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export class SheetMove {
  private st: MoveState = 'idle';
  private hand: 'left' | 'right' | null = null;
  private downAt = 0;
  private start: Vec3 = ZERO;
  private lift: Vec3 = ZERO;
  private last: Vec3 = ZERO;
  private desk: DeskPose | null = null;

  get state(): MoveState {
    return this.st;
  }

  /** The side that holds the bar, or null. */
  get holder(): 'left' | 'right' | null {
    return this.hand;
  }

  /** A press began on the bar: `at` is the pressing point in world space (a pinch point or a controller's tip). */
  down(hand: 'left' | 'right', at: Vec3, nowMs: number, desk: DeskPose): void {
    if (this.st !== 'idle') return;
    this.st = 'arming';
    this.hand = hand;
    this.downAt = nowMs;
    this.start = { ...at };
    this.last = { ...at };
    this.desk = desk;
  }

  /** Each frame while a press is on the bar; `at` is null while the pointer is not tracked (it waits). */
  update(at: Vec3 | null, nowMs: number): MoveStatus {
    if (this.st === 'idle') return { state: 'idle', progress: 0, offset: ZERO };
    if (at) this.last = { ...at };
    if (this.st === 'arming') {
      if (Math.hypot(this.last.x - this.start.x, this.last.y - this.start.y, this.last.z - this.start.z) > MOVE_STILL_M) {
        this.cancel();
        return { state: 'idle', progress: 0, offset: ZERO };
      }
      const progress = Math.min(1, (nowMs - this.downAt) / MOVE_HOLD_MS);
      if (progress < 1) return { state: 'arming', progress, offset: ZERO };
      this.st = 'moving';
      this.lift = { ...this.last };
    }
    return { state: 'moving', progress: 1, offset: this.offset() };
  }

  /** The press ended: the desk at its new place when the sheet was being carried, else null (nothing moves). */
  up(headY: number): DeskPose | null {
    const desk = this.desk;
    const moving = this.st === 'moving';
    const o = this.offset(headY);
    this.cancel();
    if (!moving || !desk) return null;
    return { ...desk, origin: { x: desk.origin.x + o.x, y: desk.origin.y + o.y, z: desk.origin.z + o.z }, deskY: desk.deskY + o.y };
  }

  cancel(): void {
    this.st = 'idle';
    this.hand = null;
    this.desk = null;
  }

  /** The carry so far; with the head's height, kept inside the band where a desk can be. */
  private offset(headY?: number): Vec3 {
    if (this.st !== 'moving' || !this.desk) return ZERO;
    const o = { x: this.last.x - this.lift.x, y: this.last.y - this.lift.y, z: this.last.z - this.lift.z };
    if (headY !== undefined) {
      const y = Math.min(headY - DWELL_BELOW_HEAD, Math.max(headY - DWELL_MAX_BELOW_HEAD, this.desk.deskY + o.y));
      o.y = y - this.desk.deskY;
    }
    return o;
  }
}

export const MOVE_LABEL = 'Hold to move';

/** The grab bar under the sheet anchor: a dark pill with its label, brighter under a pointer, with the hold ring. */
export class MoveBarView {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly ring = holdRing(0.018, '#F4F2EE');

  constructor() {
    const b = MOVE_BAR;
    this.mesh = new Mesh(
      new PlaneGeometry(b.w, b.d).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: barTexture(), color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
    );
    this.mesh.name = 'sheet-move-bar';
    // On the desk plane in front of the sheet's near edge (the sheet frame is lifted and tilted; the bar lies in it).
    this.mesh.position.set(b.x, 0.001, b.z);
    this.mesh.renderOrder = 2;
    this.ring.mesh.rotation.x = -Math.PI / 2;
    this.ring.mesh.position.set(0, 0.004, 0);
    this.mesh.add(this.ring.mesh);
  }

  set(st: MoveStatus, hovered: boolean): void {
    this.mesh.material.opacity = st.state === 'moving' ? 1 : hovered || st.state === 'arming' ? 0.95 : 0.8;
    this.mesh.material.color.set(st.state === 'moving' ? 0xbfd9ff : 0xffffff);
    this.ring.set(st.state === 'arming' ? Math.max(0.001, st.progress) : 0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
    this.ring.mesh.geometry.dispose();
    (this.ring.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.removeFromParent();
  }
}

function barTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 416;
  c.height = 96;
  const x = c.getContext('2d');
  if (!x) return null;
  const r = c.height / 2;
  x.fillStyle = 'rgba(22,26,32,0.92)';
  x.beginPath();
  x.moveTo(r, 0);
  x.lineTo(c.width - r, 0);
  x.arc(c.width - r, r, r, -Math.PI / 2, Math.PI / 2);
  x.lineTo(r, c.height);
  x.arc(r, r, r, Math.PI / 2, (3 * Math.PI) / 2);
  x.fill();
  // 13 cm across 416 px: 32 px per cm, so 1 cm letters.
  x.fillStyle = '#F4F2EE';
  x.font = '600 32px Inter, system-ui, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(MOVE_LABEL, c.width / 2, r + 2);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
