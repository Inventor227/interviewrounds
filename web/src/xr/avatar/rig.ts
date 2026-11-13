// Procedural layers on the Rocketbox Biped, applied after the AnimationMixer each frame:
// - head turn (gaze aim, nods, beats, tilt) as an extra rotation on the head bone only: on this rig the clavicles
//   hang off the neck, so turning the neck would swing the arms;
// - eyes aimed at a world point inside the head's frame, clamped to ±30° yaw and ±20° pitch, so they stay on the
//   target while the head moves (as the vestibulo-ocular reflex does);
// - forearm lifts for beat gestures, and a reach toward a point for pointAt.
//
// Angles are in the avatar root's frame (faces +Z, +Y up, +X to its left). Every write is absolute relative to the
// clip pose of this frame, so nothing accumulates.

import { Bone, MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { EYE_PITCH_MAX, EYE_YAW_MAX } from './gaze';
import type { AvatarManifestEntry } from './types';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

// Scratch values (no allocation per frame).
const qa = new Quaternion();
const qb = new Quaternion();
const qc = new Quaternion();
const qRoot = new Quaternion();
const qRootInv = new Quaternion();
const va = new Vector3();
const vb = new Vector3();
const vc = new Vector3();
const vd = new Vector3();
const ve = new Vector3();
const m4 = new Matrix4();
const scl = new Vector3();

/** Rotation of an object in world space (matrixWorld must be current). */
function worldQuat(o: Object3D, out: Quaternion): Quaternion {
  o.matrixWorld.decompose(ve, out, scl);
  return out;
}

/** Applies a world-space rotation `rw` to bone `b` (premultiplied in its parent's frame). Parent matrix current. */
function rotateWorld(b: Object3D, rw: Quaternion): void {
  const parent = b.parent;
  if (!parent) return;
  worldQuat(parent, qb);
  // local' = (P^-1 · R · P) · local
  qc.copy(qb).invert().multiply(rw).multiply(qb);
  b.quaternion.premultiply(qc);
}

interface Arm {
  upper: Bone;
  fore: Bone;
  hand: Bone;
}

interface Eye {
  bone: Bone;
  rest: Quaternion;
}

export class Rig {
  readonly head: Bone;
  readonly eyes: Eye[];
  readonly armL: Arm | null;
  readonly armR: Arm | null;
  /** Head-local basis of the avatar's forward, up and left directions (from the bind pose). */
  private readonly hFwd = new Vector3();
  private readonly hUp = new Vector3();
  private readonly hSide = new Vector3();
  /** Eye midpoint in the avatar root's frame, updated by applyEyes. */
  readonly eyeCenter = new Vector3();

  constructor(
    private readonly root: Object3D,
    model: Object3D,
    entry: AvatarManifestEntry,
  ) {
    const bone = (name: string) => {
      const o = model.getObjectByName(name);
      return o instanceof Bone ? o : null;
    };
    const head = bone(entry.head_bone);
    if (!head) throw new Error(`avatar ${entry.id}: no head bone ${entry.head_bone}`);
    this.head = head;
    const eyeNames = entry.eye_bones ?? [entry.eye_bone];
    this.eyes = eyeNames.flatMap((n) => {
      const b = bone(n);
      return b ? [{ bone: b, rest: b.quaternion.clone() }] : [];
    });
    const arm = (s: 'L' | 'R'): Arm | null => {
      const upper = bone(`Bip01_${s}_UpperArm`);
      const fore = bone(`Bip01_${s}_Forearm`);
      const hand = bone(`Bip01_${s}_Hand`);
      return upper && fore && hand ? { upper, fore, hand } : null;
    };
    this.armL = arm('L');
    this.armR = arm('R');

    // Bind pose: the head faces the avatar's forward. Express the root axes in head-local space.
    root.updateWorldMatrix(true, true);
    worldQuat(root, qRoot);
    worldQuat(head, qa);
    qa.premultiply(qRootInv.copy(qRoot).invert()); // head relative to root
    qa.invert();
    this.hFwd.copy(Z).applyQuaternion(qa);
    this.hUp.copy(Y).applyQuaternion(qa);
    this.hSide.copy(X).applyQuaternion(qa);
    this.measureEyes();
  }

  /** Call once per frame before the apply* methods: caches the root's world rotation. */
  begin(): void {
    this.root.updateWorldMatrix(true, false);
    worldQuat(this.root, qRoot);
    qRootInv.copy(qRoot).invert();
  }

  /** Extra head rotation in the root frame: yaw (to its left), pitch (up), roll (tilt toward its left shoulder). */
  applyHead(yaw: number, pitch: number, roll: number): void {
    qa.setFromAxisAngle(Y, yaw).multiply(qb.setFromAxisAngle(X, -pitch)).multiply(qc.setFromAxisAngle(Z, -roll));
    // To world: Rw = Qroot · R · Qroot^-1
    const rw = qa.premultiply(qRoot).multiply(qRootInv);
    this.head.parent?.updateWorldMatrix(true, false);
    rotateWorld(this.head, rw);
  }

  /**
   * Aims both eyes at a world point. Call after applyHead. Each eye turns inside the head's frame, clamped to the
   * eye limits, so the eyes hold the target while the head moves.
   */
  applyEyes(targetWorld: Vector3): void {
    this.head.updateWorldMatrix(false, false);
    worldQuat(this.head, qa);
    qa.invert();
    for (const e of this.eyes) {
      va.copy(e.bone.position).applyMatrix4(this.head.matrixWorld); // eye centre, world
      vb.subVectors(targetWorld, va).applyQuaternion(qa); // direction in head space
      const f = vb.dot(this.hFwd);
      const yaw = MathUtils.clamp(Math.atan2(vb.dot(this.hSide), f), -EYE_YAW_MAX, EYE_YAW_MAX);
      const pitch = MathUtils.clamp(
        Math.atan2(vb.dot(this.hUp), Math.hypot(f, vb.dot(this.hSide))),
        -EYE_PITCH_MAX,
        EYE_PITCH_MAX,
      );
      e.bone.quaternion
        .copy(e.rest)
        .premultiply(qc.setFromAxisAngle(this.hSide, -pitch))
        .premultiply(qb.setFromAxisAngle(this.hUp, yaw));
    }
    this.measureEyes();
  }

  /** Lifts a forearm by `angle` radians (elbow flexion: the hand rises). */
  liftForearm(side: 'L' | 'R', angle: number): void {
    const arm = side === 'L' ? this.armL : this.armR;
    if (!arm || Math.abs(angle) < 1e-4) return;
    arm.hand.updateWorldMatrix(true, false);
    const s = va.setFromMatrixPosition(arm.upper.matrixWorld);
    const e = vb.setFromMatrixPosition(arm.fore.matrixWorld);
    const h = vc.setFromMatrixPosition(arm.hand.matrixWorld);
    const u = vd.subVectors(e, s);
    const f = h.sub(e); // forearm direction (vc reused)
    const axis = u.cross(f); // vd reused
    if (axis.lengthSq() < 1e-10) return;
    axis.normalize();
    // Pick the sign that raises the hand.
    qa.setFromAxisAngle(axis, angle);
    const up = ve.copy(f).applyQuaternion(qa).y - f.y;
    if (up < 0) qa.setFromAxisAngle(axis, -angle);
    rotateWorld(arm.fore, qa);
  }

  /** Reaches toward a world point with weight w (0..1): opens the elbow and swings the upper arm toward it. */
  reach(side: 'L' | 'R', targetWorld: Vector3, w: number): void {
    const arm = side === 'L' ? this.armL : this.armR;
    if (!arm || w < 1e-3) return;
    arm.hand.updateWorldMatrix(true, false);
    const s = va.setFromMatrixPosition(arm.upper.matrixWorld);
    const e = vb.setFromMatrixPosition(arm.fore.matrixWorld);
    const h = vc.setFromMatrixPosition(arm.hand.matrixWorld);
    const u = vd.subVectors(e, s);
    const f = ve.subVectors(h, e);
    const bend = u.angleTo(f);
    const axis = u.clone().cross(f);
    if (axis.lengthSq() > 1e-10) {
      axis.normalize();
      // Open the elbow by 70 % of its bend (the sign that reduces the angle between upper arm and forearm).
      const open = 0.7 * bend * w;
      qa.setFromAxisAngle(axis, open);
      const test = f.clone().applyQuaternion(qa);
      if (test.angleTo(u) > bend) qa.setFromAxisAngle(axis, -open);
      rotateWorld(arm.fore, qa);
    }
    arm.hand.updateWorldMatrix(true, false);
    h.setFromMatrixPosition(arm.hand.matrixWorld);
    const cur = vd.subVectors(h, s).normalize();
    const want = ve.subVectors(targetWorld, s).normalize();
    qa.setFromUnitVectors(cur, want);
    // At most 80° of swing, scaled by w.
    const ang = 2 * Math.acos(Math.min(1, Math.abs(qa.w)));
    const t = ang > 1e-5 ? (Math.min(ang, MathUtils.degToRad(80)) / ang) * w : w;
    qa.slerpQuaternions(qb.identity(), qa, t);
    rotateWorld(arm.upper, qa);
  }

  /** Converts a world point into the root frame. */
  toRoot(world: Vector3, out: Vector3): Vector3 {
    m4.copy(this.root.matrixWorld).invert();
    return out.copy(world).applyMatrix4(m4);
  }

  /** Converts a root-frame point to world. */
  toWorld(local: Vector3, out: Vector3): Vector3 {
    return out.copy(local).applyMatrix4(this.root.matrixWorld);
  }

  private measureEyes(): void {
    if (!this.eyes.length) {
      this.head.updateWorldMatrix(true, false);
      this.toRoot(va.setFromMatrixPosition(this.head.matrixWorld), this.eyeCenter);
      return;
    }
    this.eyeCenter.set(0, 0, 0);
    for (const e of this.eyes) {
      va.copy(e.bone.position).applyMatrix4(this.head.matrixWorld);
      this.eyeCenter.add(va);
    }
    this.eyeCenter.multiplyScalar(1 / this.eyes.length);
    this.toRoot(vb.copy(this.eyeCenter), this.eyeCenter);
  }
}
