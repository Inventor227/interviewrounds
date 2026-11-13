// The room around the user's desk: a virtual table slab meeting the real desk's far edge, chairs, contact shadows,
// the wall whiteboard and the sheet frame. In passthrough an invisible occluder stands in for the real desk so the
// panelists' legs and chairs disappear behind it, the way they would behind a real table.
//
// Draw calls: slab 1, occluder 1, chairs 1 (merged), wall board 2, contact shadows 1 per seat, sheet 1.

import { ContactShadow, type Entity, type World } from '@iwsdk/core';
import {
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  CylinderGeometry,
  DirectionalLight,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { addScaled, forwardOf, rightOf, v3 } from './math';
import type { DeskPose } from './placement';
import {
  AVATAR_DESK_Y,
  REAL_DESK_FAR,
  SHEET_D,
  SHEET_TILT,
  SHEET_W,
  seatLayout,
  sheetPoint,
  tableSlab,
  wallboardPose,
  type SeatPose,
} from './seats';
import { Wallboard } from './wallboard';

export const SLAB_COLOR = 0xa88f70;
const SLAB_T = 0.03;
/** Near edge fade of the slab, so the seam with a real desk of any colour reads soft. */
const SLAB_FADE = 0.07;
/** The occluder reaches this far behind the sheet's near edge (under the user's forearms). */
const OCCLUDER_NEAR = 0.32;

export interface RoomOptions {
  /** Passthrough builds the slab and the desk occluder; the preview builds its own full table instead. */
  mode: 'ar' | 'preview';
}

export class Room {
  /** Anchored frame: everything desk-relative lives under it. */
  readonly root = new Group();
  readonly wallboard = new Wallboard();
  /** Sheet frame: origin at the sheet's near edge centre, +X right, -Z toward the far edge, +Y the surface normal. */
  readonly sheetAnchor = new Object3D();
  /** Placeholder sheet until the board draws its own. */
  readonly sheet: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly light: DirectionalLight;
  private readonly rootEntity: Entity;
  private slab: Mesh | null = null;
  private occluder: Mesh | null = null;
  private chairs: Mesh | null = null;
  private shadows: Entity[] = [];
  private seats: SeatPose[] = [];
  private deskPose: DeskPose | null = null;
  private readonly slabMat = new MeshStandardMaterial({ color: SLAB_COLOR, roughness: 0.62, metalness: 0, vertexColors: true, transparent: true });
  private readonly chairMat = new MeshStandardMaterial({ color: 0x2e3135, roughness: 0.85, metalness: 0.05 });
  private readonly occluderMat = new MeshBasicMaterial({ colorWrite: false });

  constructor(
    private readonly world: World,
    private readonly opts: RoomOptions,
  ) {
    this.root.name = 'room';
    this.rootEntity = world.createTransformEntity(this.root);
    this.root.add(this.wallboard.group, this.sheetAnchor);
    this.wallboard.group.visible = false;
    this.sheet = makeSheet();
    this.sheet.visible = false;
    this.sheetAnchor.add(this.sheet);
    // One soft key light from above and in front of the panel; IBL does the rest. No shadow map: contact shadows only.
    this.light = new DirectionalLight(0xfff4e8, 1.1);
    this.light.name = 'key-light';
    this.root.add(this.light, this.light.target);
  }

  get desk(): DeskPose | null {
    return this.deskPose;
  }

  seatPoses(): SeatPose[] {
    return this.seats.map((s) => ({ ...s, pos: { ...s.pos }, eye: { ...s.eye } }));
  }

  /** Attach the board canvas (Task 15 mirrors the sheet into it); null restores the clean surface. */
  wallboardTexture(tex: Texture | null): void {
    this.wallboard.setTexture(tex);
  }

  /** Builds the table, chairs and shadows for n seats around this desk. Safe to call again (re-placement). */
  place(desk: DeskPose, n: 1 | 2 | 3): SeatPose[] {
    this.clear();
    this.deskPose = desk;
    this.seats = seatLayout(n, desk);
    const f = forwardOf(desk.yaw);
    const r = rightOf(desk.yaw);
    const slab = tableSlab(n, desk);

    if (this.opts.mode === 'ar') {
      this.slab = new Mesh(slabGeometry(slab.width, slab.depth), this.slabMat);
      this.slab.name = 'table-slab';
      this.slab.position.set(slab.center.x, desk.deskY - SLAB_T / 2, slab.center.z);
      this.slab.rotation.y = desk.yaw;
      // Transparent only for its faded lip: draw it before the contact shadows that sit on it.
      this.slab.renderOrder = -1;
      this.root.add(this.slab);

      // Depth-only stand-in for the real desk and the space under the slab, drawn first.
      const near = -OCCLUDER_NEAR;
      const far = REAL_DESK_FAR + slab.depth;
      const bottom = Math.min(0, desk.deskY - AVATAR_DESK_Y) - 0.05;
      const h = desk.deskY - 0.002 - bottom;
      this.occluder = new Mesh(new BoxGeometry(slab.width + 0.3, h, far - near), this.occluderMat);
      this.occluder.name = 'desk-occluder';
      const c = addScaled(v3(slab.center.x, 0, slab.center.z), f, (near + far) / 2 - (REAL_DESK_FAR + slab.depth / 2));
      this.occluder.position.set(c.x, bottom + h / 2, c.z);
      this.occluder.rotation.y = desk.yaw;
      this.occluder.renderOrder = -100;
      this.root.add(this.occluder);
    }

    this.chairs = new Mesh(chairsGeometry(this.seats), this.chairMat);
    this.chairs.name = 'chairs';
    this.root.add(this.chairs);

    // Soft shadows where the panelists' forearms rest on the slab.
    for (const s of this.seats) {
      const fwd = forwardOf(s.yaw + Math.PI); // the avatar's front, toward the user
      const p = addScaled(v3(s.pos.x, desk.deskY, s.pos.z), fwd, -0.33);
      const o = new Object3D();
      o.position.set(p.x, desk.deskY, p.z);
      o.rotation.y = s.yaw;
      const e = this.world.createTransformEntity(o, this.rootEntity);
      e.addComponent(ContactShadow, { size: [0.62, 0.3], opacity: 0.42, height: 0.0015 });
      this.shadows.push(e);
    }

    // Key light: above the panel's left shoulder, aimed at the lead.
    const lead = this.seats[0]!;
    const lp = addScaled(addScaled(v3(lead.eye.x, lead.eye.y + 1.6, lead.eye.z), f, -0.9), r, -0.8);
    this.light.position.set(lp.x, lp.y, lp.z);
    this.light.target.position.set(lead.eye.x, lead.eye.y - 0.3, lead.eye.z);

    this.wallboard.place(wallboardPose(desk));
    this.wallboard.group.visible = true;

    const sp = sheetPoint(desk, 0, 0, 0);
    this.sheetAnchor.position.set(sp.x, sp.y, sp.z);
    this.sheetAnchor.rotation.copy(new Euler(SHEET_TILT, desk.yaw, 0, 'YXZ'));
    this.sheet.visible = true;
    return this.seatPoses();
  }

  /** Extra shadow blobs (preview: under the chairs on the floor). */
  addFloorShadows(floorY: number): void {
    for (const s of this.seats) {
      const o = new Object3D();
      o.position.set(s.pos.x, floorY, s.pos.z);
      const e = this.world.createTransformEntity(o, this.rootEntity);
      e.addComponent(ContactShadow, { size: [0.8, 0.8], opacity: 0.5, height: 0.002 });
      this.shadows.push(e);
    }
  }

  /** Moves the whole anchored room by a rigid transform (anchor drift correction). */
  setAnchorOffset(m: Matrix4): void {
    this.root.matrixAutoUpdate = false;
    this.root.matrix.copy(m);
    this.root.matrixWorldNeedsUpdate = true;
  }

  private clear(): void {
    for (const m of [this.slab, this.occluder, this.chairs]) {
      if (!m) continue;
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.slab = this.occluder = this.chairs = null;
    for (const e of this.shadows) e.destroy();
    this.shadows = [];
  }

  dispose(): void {
    this.clear();
    this.rootEntity.destroy();
  }
}

/** Slab box plus a fading lip at the near edge, as one geometry with RGBA vertex colours. */
function slabGeometry(width: number, depth: number): BufferGeometry {
  // Local frame: front (toward the user) is +Z, top at y = +SLAB_T/2.
  const body = new BoxGeometry(width, SLAB_T, depth - SLAB_FADE).translate(0, 0, -SLAB_FADE / 2);
  const lip = new PlaneGeometry(width, SLAB_FADE, 1, 1).rotateX(-Math.PI / 2).translate(0, SLAB_T / 2, depth / 2 - SLAB_FADE / 2);
  for (const g of [body, lip]) {
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 4).fill(1);
    if (g === lip) {
      const pos = g.getAttribute('position');
      for (let i = 0; i < n; i++) if (pos.getZ(i) > depth / 2 - 0.001) col[i * 4 + 3] = 0;
    }
    g.setAttribute('color', new BufferAttribute(col, 4));
  }
  const out = mergeGeometries([body, lip])!;
  body.dispose();
  lip.dispose();
  return out;
}

/** One merged geometry for every chair: seat, tilted back, gas column and a five-spoke base. */
function chairsGeometry(seats: SeatPose[]): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  for (const s of seats) {
    const base = new Matrix4().compose(new Vector3(s.pos.x, s.pos.y, s.pos.z), q.setFromEuler(new Euler(0, s.yaw, 0)), new Vector3(1, 1, 1));
    const add = (g: BufferGeometry, local?: Matrix4) => {
      if (local) g.applyMatrix4(local);
      g.applyMatrix4(base);
      parts.push(g.toNonIndexed());
      g.dispose();
    };
    add(new BoxGeometry(0.5, 0.07, 0.48), m.makeTranslation(0, 0.445, -0.03));
    add(new BoxGeometry(0.48, 0.5, 0.07), new Matrix4().compose(new Vector3(0, 0.8, -0.3), new Quaternion().setFromEuler(new Euler(-0.14, 0, 0)), new Vector3(1, 1, 1)));
    add(new BoxGeometry(0.06, 0.32, 0.04), m.makeTranslation(0, 0.56, -0.28));
    add(new CylinderGeometry(0.028, 0.032, 0.34, 10), m.makeTranslation(0, 0.24, -0.03));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(
        new BoxGeometry(0.3, 0.03, 0.045),
        new Matrix4().compose(new Vector3(Math.cos(a) * 0.15, 0.06, -0.03 - Math.sin(a) * 0.15), new Quaternion().setFromEuler(new Euler(0, a, 0)), new Vector3(1, 1, 1)),
      );
    }
  }
  const out = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return out;
}

/** A plain paper sheet with a faint dot grid, near edge at the origin, extending toward -Z. */
function makeSheet(): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const g = new PlaneGeometry(SHEET_W, SHEET_D).rotateX(-Math.PI / 2).translate(0, 0, -SHEET_D / 2);
  const tex = sheetTexture();
  const mesh = new Mesh(g, new MeshBasicMaterial({ map: tex, toneMapped: false, transparent: true, opacity: 0.96 }));
  mesh.name = 'sheet-placeholder';
  // Before the panels that lie on it (the brief card), which do not write depth.
  mesh.renderOrder = -2;
  return mesh;
}

function sheetTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const x = c.getContext('2d');
  if (!x) return null;
  x.fillStyle = '#f5f3ee';
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = 'rgba(60,64,72,0.16)';
  for (let i = 16; i < c.width; i += 32) for (let j = 16; j < c.height; j += 32) x.fillRect(i - 1, j - 1, 2, 2);
  x.strokeStyle = 'rgba(31,78,121,0.35)';
  x.lineWidth = 3;
  x.strokeRect(1.5, 1.5, c.width - 3, c.height - 3);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
