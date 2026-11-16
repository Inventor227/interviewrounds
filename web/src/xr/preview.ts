// Preview mode (no WebXR: desktop, phone, the demo video): the same table, people and panels in a calm virtual
// meeting room, seen from the user's chair. Soft warm walls, a window on the left for daylight, a wall board behind
// the panel. The mouse looks around a little; the panel chrome rides with the camera so it is always reachable.

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type BufferGeometry,
  type PerspectiveCamera,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addScaled, DEG, forwardOf, v3 } from './math';
import type { DeskPose, HeadPose } from './placement';
import { SLAB_FAR, tableSlab, userPoint, wallboardPose, type SeatPose } from './seats';
import { SLAB_COLOR } from './room';

/** The desk in preview: a 0.74 m table, the user facing -Z. */
export const PREVIEW_DESK: DeskPose = { origin: { x: 0, y: 0.74, z: -0.3 }, yaw: 0, deskY: 0.74, source: 'preview' };
/** Seated eye height above the desk, and how far behind the user point the camera sits to see the sheet. */
const EYE_ABOVE_DESK = 0.5;
const CAMERA_BACK = 0.32;
export const PREVIEW_FOV = 60;

/**
 * Drawing buffer limits for the preview. The world starts at the screen's full device pixel ratio with MSAA, which on
 * a phone (2.6 to 4) makes the hidden 960 x 540 room of the Ready step a 2640 x 1485 buffer and the page's small
 * stage about 1045 x 588: far more pixels than the view needs, every frame, on the device with the least memory.
 */
export const PREVIEW_MAX_RATIO = 2;
export const PREVIEW_MAX_PIXELS = 2_000_000;

/**
 * The pixel ratio the preview draws at for a cssW x cssH stage: the device's own, at most PREVIEW_MAX_RATIO and at most
 * what keeps the buffer within PREVIEW_MAX_PIXELS, never under 1 (a big desktop stage stays sharp) unless the device
 * itself is under 1.
 */
export function previewPixelRatio(dpr: number, cssW: number, cssH: number): number {
  const device = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const area = cssW * cssH;
  const budget = area > 0 ? Math.sqrt(PREVIEW_MAX_PIXELS / area) : Infinity;
  return Math.max(Math.min(device, 1), Math.min(device, PREVIEW_MAX_RATIO, budget));
}

const WALL = 0xe9e4db;
const FLOOR = 0x6e6862;
const TRIM = 0xd7d0c5;
const LEG = 0x3a3c40;

export interface PreviewRoom {
  group: Group;
  /** The camera pose at rest (before mouse look). */
  rest: HeadPose;
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  const ni = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const out = mergeGeometries(ni)!;
  parts.forEach((p) => p.dispose());
  ni.forEach((p) => p.dispose());
  return out;
}

export function buildPreviewRoom(desk: DeskPose, n: 1 | 2 | 3, seats: SeatPose[]): PreviewRoom {
  const group = new Group();
  group.name = 'preview-room';
  const user = userPoint(desk);
  const f = forwardOf(desk.yaw);
  const board = wallboardPose(desk);
  const backZ = board.pos.z - 0.06;
  const W = 4.4;
  const H = 2.75;
  const frontZ = user.z + 1.8;
  const D = frontZ - backZ;
  const midZ = (frontZ + backZ) / 2;

  // Walls and ceiling share one warm matte material.
  const wallsGeom = merged([
    new PlaneGeometry(W, H).translate(0, H / 2, backZ),
    new PlaneGeometry(D, H).rotateY(Math.PI / 2).translate(-W / 2, H / 2, midZ),
    new PlaneGeometry(D, H).rotateY(-Math.PI / 2).translate(W / 2, H / 2, midZ),
    new PlaneGeometry(W, H).rotateY(Math.PI).translate(0, H / 2, frontZ),
    new PlaneGeometry(W, D).rotateX(Math.PI / 2).translate(0, H, midZ),
  ]);
  const walls = new Mesh(wallsGeom, new MeshStandardMaterial({ color: WALL, roughness: 0.95 }));
  walls.name = 'preview-walls';
  const floor = new Mesh(new PlaneGeometry(W, D).rotateX(-Math.PI / 2).translate(0, 0, midZ), new MeshStandardMaterial({ color: FLOOR, roughness: 0.98 }));
  floor.name = 'preview-floor';

  // Window on the left wall: bright glass, frame and sill in the trim colour, plus baseboards.
  const winZ = seats[0]!.pos.z - 0.45;
  const winW = 2.0;
  const winH = 1.45;
  const winY = 1.45;
  const glass = new Mesh(
    new PlaneGeometry(winW, winH).rotateY(Math.PI / 2).translate(-W / 2 + 0.005, winY, winZ),
    new MeshBasicMaterial({ color: new Color(0xeaf0f4), toneMapped: false }),
  );
  glass.name = 'preview-window';
  const trimParts = [
    new BoxGeometry(0.06, 0.06, winW + 0.12).translate(-W / 2 + 0.03, winY + winH / 2 + 0.03, winZ),
    new BoxGeometry(0.12, 0.04, winW + 0.12).translate(-W / 2 + 0.06, winY - winH / 2 - 0.02, winZ),
    new BoxGeometry(0.06, winH, 0.06).translate(-W / 2 + 0.03, winY, winZ - winW / 2 - 0.03),
    new BoxGeometry(0.06, winH, 0.06).translate(-W / 2 + 0.03, winY, winZ + winW / 2 + 0.03),
    new BoxGeometry(0.04, winH, 0.04).translate(-W / 2 + 0.02, winY, winZ),
    new BoxGeometry(W, 0.09, 0.015).translate(0, 0.045, backZ + 0.008),
    new BoxGeometry(0.015, 0.09, D).translate(-W / 2 + 0.008, 0.045, midZ),
    new BoxGeometry(0.015, 0.09, D).translate(W / 2 - 0.008, 0.045, midZ),
  ];
  const trim = new Mesh(merged(trimParts), new MeshStandardMaterial({ color: TRIM, roughness: 0.7 }));
  trim.name = 'preview-trim';

  // Felt panels on the right wall for a little colour.
  const felt = new Mesh(
    merged([
      new BoxGeometry(0.03, 1.2, 0.5).translate(W / 2 - 0.015, 1.45, seats[0]!.pos.z - 0.2),
      new BoxGeometry(0.03, 1.2, 0.5).translate(W / 2 - 0.015, 1.45, seats[0]!.pos.z + 0.4),
    ]),
    new MeshStandardMaterial({ color: 0x6f7a5e, roughness: 1 }),
  );
  felt.name = 'preview-felt';

  // The table: the user's end (under the sheet) to the panel's end, one top, dark legs and a modesty panel.
  const slab = tableSlab(n, desk);
  const nearD = -0.38; // behind the sheet's near edge, under the user's forearms
  const farD = SLAB_FAR;
  const depth = farD - nearD;
  const centre = addScaled(v3(slab.center.x, 0, slab.center.z), f, (nearD + farD) / 2 - (SLAB_FAR - slab.depth / 2));
  const t = 0.035;
  const top = new Mesh(new BoxGeometry(slab.width, t, depth).translate(0, desk.deskY - t / 2, 0), new MeshStandardMaterial({ color: SLAB_COLOR, roughness: 0.55 }));
  top.position.set(centre.x, 0, centre.z);
  top.rotation.y = desk.yaw;
  top.name = 'preview-table';
  const legH = desk.deskY - t;
  const lx = slab.width / 2 - 0.08;
  const lz = depth / 2 - 0.08;
  const legs = new Mesh(
    merged([
      ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => new CylinderGeometry(0.025, 0.025, legH, 10).translate(sx * lx, legH / 2, sz * lz))),
      new BoxGeometry(slab.width - 0.2, 0.32, 0.015).translate(0, legH - 0.18, -lz),
    ]),
    new MeshStandardMaterial({ color: LEG, roughness: 0.5, metalness: 0.3 }),
  );
  legs.position.copy(top.position);
  legs.rotation.y = desk.yaw;
  legs.name = 'preview-legs';

  // Daylight from the window, a warm fill from the room; no shadow maps (contact shadows ground things).
  const sun = new DirectionalLight(0xfff1e0, 1.4);
  sun.position.set(-W / 2 - 1, 2.6, winZ + 0.4);
  sun.target.position.set(0, 0.9, seats[0]!.pos.z);
  const hemi = new HemisphereLight(0xf4efe8, 0x6b6157, 0.55);

  group.add(walls, floor, glass, trim, felt, top, legs, sun, sun.target, hemi);

  const camPos = addScaled(v3(user.x, desk.deskY + EYE_ABOVE_DESK, user.z), f, -CAMERA_BACK);
  const lead = seats[0]!;
  const dir = v3(lead.eye.x - camPos.x, lead.eye.y - 0.3 - camPos.y, lead.eye.z - camPos.z);
  const yaw = Math.atan2(-dir.x, -dir.z);
  const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
  return { group, rest: { pos: camPos, yaw, pitch } };
}

/** Mouse look: small yaw and pitch offsets that ease toward the pointer, like a seated head turn. */
export class MouseLook {
  private tx = 0;
  private ty = 0;
  private x = 0;
  private y = 0;
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onLeave: () => void;

  constructor(
    private readonly el: HTMLElement,
    private readonly maxYaw = 14 * DEG,
    private readonly maxPitch = 8 * DEG,
  ) {
    this.onMove = (e) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      this.tx = MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      this.ty = MathUtils.clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    };
    this.onLeave = () => {
      this.tx = 0;
      this.ty = 0;
    };
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerleave', this.onLeave);
  }

  /** Applies rest pose plus the eased offset to the camera. */
  apply(camera: PerspectiveCamera, rest: HeadPose, dt: number): void {
    const k = 1 - Math.exp(-dt * 3);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    // Only look around when the pointer is near the edges, so pressing buttons does not swing the view.
    const dead = (v: number) => Math.sign(v) * Math.max(0, Math.abs(v) - 0.35) / 0.65;
    camera.position.set(rest.pos.x, rest.pos.y, rest.pos.z);
    camera.rotation.set(rest.pitch - dead(this.y) * this.maxPitch, rest.yaw - dead(this.x) * this.maxYaw, 0, 'YXZ');
  }

  dispose(): void {
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerleave', this.onLeave);
  }
}
