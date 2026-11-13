// Gaze: where the head and the eyes point, as yaw/pitch angles in the avatar's own frame.
//
// Frame: the avatar root faces +Z, +Y is up, +X is the avatar's left. Yaw is positive toward +X, pitch positive up.
//
// - The head turns toward the target but is clamped to ±35° yaw and ±20° pitch, and follows slowly (smooth damp,
//   about 250 ms); the eyes jump there fast (about 30 ms) and cover what the head cannot, so the eyes lead.
// - Micro-saccades: every 0.8 to 2.5 s the eyes hop 0.5 to 2° (mostly sideways), or back to centre.
// - Speaking: glances 5 to 12° away (sideways or up) every 1.5 to 4 s, back after 0.4 to 1.2 s, as in "Eyes Alive".
// - Thinking: eyes up and to the side for 0.6 s, then back.

import { Vector3 } from 'three';
import { approach, between, type Rng } from './rng';
import type { AvatarMode, Vec3Like } from './types';

export const DEG = Math.PI / 180;
export const HEAD_YAW_MAX = 35 * DEG;
export const HEAD_PITCH_MAX = 20 * DEG;
/** Eye rotation limits relative to the head. */
export const EYE_YAW_MAX = 30 * DEG;
export const EYE_PITCH_MAX = 20 * DEG;

const HEAD_SMOOTH_S = 0.25;
const EYE_TAU_S = 0.03;
const SACCADE_MIN_MS = 800;
const SACCADE_MAX_MS = 2500;
const MICRO_MIN = 0.5 * DEG;
const MICRO_MAX = 2 * DEG;
/** Chance a micro-saccade goes back to the centre of the face instead of a new point. */
const MICRO_RECENTRE = 0.3;
/** Idle head sway so the head never locks still (well under a degree and a half). */
const SWAY_YAW = 1.2 * DEG;
const SWAY_PITCH = 0.7 * DEG;
/** The thinking look: up and to the avatar's left, for 0.6 s. */
export const THINK_LOOK = { yaw: 18 * DEG, pitch: 16 * DEG, seconds: 0.6 };
/** Jumps of the eye target above this count as big shifts (the avatar may blink with them). */
const BIG_SHIFT = 8 * DEG;

export interface Angles {
  yaw: number;
  pitch: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Yaw and pitch of the direction from `from` to `to`. */
export function anglesTo(from: Vec3Like, to: Vec3Like, out: Angles = { yaw: 0, pitch: 0 }): Angles {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  out.yaw = Math.atan2(dx, dz);
  out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return out;
}

/** Unit direction for a yaw and pitch. */
export function dirFromAngles(yaw: number, pitch: number, out = new Vector3()): Vector3 {
  const c = Math.cos(pitch);
  return out.set(c * Math.sin(yaw), Math.sin(pitch), c * Math.cos(yaw));
}

export function clampHead(a: Angles): Angles {
  return { yaw: clamp(a.yaw, -HEAD_YAW_MAX, HEAD_YAW_MAX), pitch: clamp(a.pitch, -HEAD_PITCH_MAX, HEAD_PITCH_MAX) };
}

/**
 * Where the head should aim to look at the user, in the avatar frame: the direction from the head to the user plus
 * a slow sway driven by `t` (seconds), clamped to ±35° yaw and ±20° pitch, at the user's distance.
 */
export function gazeTarget(head: Vec3Like, user: Vec3Like, t: number, out = new Vector3()): Vector3 {
  const a = anglesTo(head, user, scratch);
  const yaw = clamp(a.yaw + SWAY_YAW * Math.sin(0.31 * t) * Math.sin(0.17 * t + 1.3), -HEAD_YAW_MAX, HEAD_YAW_MAX);
  const pitch = clamp(a.pitch + SWAY_PITCH * Math.sin(0.23 * t + 0.7), -HEAD_PITCH_MAX, HEAD_PITCH_MAX);
  const dist = Math.hypot(user.x - head.x, user.y - head.y, user.z - head.z);
  dirFromAngles(yaw, pitch, out).multiplyScalar(dist);
  out.x += head.x;
  out.y += head.y;
  out.z += head.z;
  return out;
}
const scratch: Angles = { yaw: 0, pitch: 0 };

/** Wait before the next micro-saccade: uniform in [800, 2500] ms. */
export function nextSaccadeMs(rng: Rng): number {
  return between(rng, SACCADE_MIN_MS, SACCADE_MAX_MS);
}

/** Critically damped spring toward a target (like Unity's SmoothDamp). Returns the new value; updates vel[i]. */
function smoothDamp(cur: number, target: number, vel: number[], i: number, smooth: number, dt: number): number {
  const omega = 2 / smooth;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = ((vel[i] ?? 0) + omega * change) * dt;
  vel[i] = ((vel[i] ?? 0) - omega * temp) * exp;
  return target + (change + temp) * exp;
}

export class GazeController {
  /** Head aim (clamped), avatar frame, radians. */
  headYaw = 0;
  headPitch = 0;
  /** Eye gaze direction, avatar frame, radians (not relative to the head). */
  eyeYaw = 0;
  eyePitch = 0;
  /** True on a frame where the eye target jumped more than 8°. */
  bigShift = false;
  /** Tests switch the random eye movements off. */
  saccadesEnabled = true;

  private mode: AvatarMode = 'idle';
  private readonly vel = [0, 0];
  private sacYaw = 0;
  private sacPitch = 0;
  private sacWait: number;
  private glanceYaw = 0;
  private glancePitch = 0;
  private glanceHead = 0;
  private glanceLeft = 0;
  private glanceWait = 0;
  private lastEyeYaw = 0;
  private lastEyePitch = 0;

  constructor(private readonly rng: Rng) {
    this.sacWait = nextSaccadeMs(rng) / 1000;
    this.glanceWait = this.nextGlanceWait();
  }

  setMode(mode: AvatarMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.glanceLeft = 0;
    if (mode === 'thinking') this.glance(THINK_LOOK.yaw, THINK_LOOK.pitch, THINK_LOOK.seconds, 0.25);
    this.glanceWait = mode === 'speaking' ? between(this.rng, 0.3, 1.2) : this.nextGlanceWait();
  }

  /** Look away by (yaw, pitch) from the target for `seconds`; the head follows by `headShare`. */
  glance(yaw: number, pitch: number, seconds: number, headShare = 0.3): void {
    this.glanceYaw = yaw;
    this.glancePitch = pitch;
    this.glanceHead = headShare;
    this.glanceLeft = seconds;
  }

  /**
   * Advances by dt seconds toward `target` (direction from the eyes to what the avatar attends to). `head`, when
   * given, is where the head should aim instead (for example the swaying aim from gazeTarget).
   */
  update(dt: number, target: Angles, head: Angles = target): void {
    this.schedule(dt);
    const gy = this.glanceLeft > 0 ? this.glanceYaw : 0;
    const gp = this.glanceLeft > 0 ? this.glancePitch : 0;
    const gh = this.glanceLeft > 0 ? this.glanceHead : 0;

    const hy = clamp(head.yaw + gy * gh, -HEAD_YAW_MAX, HEAD_YAW_MAX);
    const hp = clamp(head.pitch + gp * gh, -HEAD_PITCH_MAX, HEAD_PITCH_MAX);
    this.headYaw = smoothDamp(this.headYaw, hy, this.vel, 0, HEAD_SMOOTH_S, dt);
    this.headPitch = smoothDamp(this.headPitch, hp, this.vel, 1, HEAD_SMOOTH_S, dt);

    let eyeY = target.yaw + gy + this.sacYaw;
    let eyeP = target.pitch + gp + this.sacPitch;
    this.bigShift = Math.hypot(eyeY - this.lastEyeYaw, eyeP - this.lastEyePitch) > BIG_SHIFT;
    this.lastEyeYaw = eyeY;
    this.lastEyePitch = eyeP;
    // The eyes can only lead the head by so much.
    eyeY = clamp(eyeY, this.headYaw - EYE_YAW_MAX, this.headYaw + EYE_YAW_MAX);
    eyeP = clamp(eyeP, this.headPitch - EYE_PITCH_MAX, this.headPitch + EYE_PITCH_MAX);
    const k = approach(dt, EYE_TAU_S);
    this.eyeYaw += (eyeY - this.eyeYaw) * k;
    this.eyePitch += (eyeP - this.eyePitch) * k;
  }

  private nextGlanceWait(): number {
    switch (this.mode) {
      case 'speaking':
        return between(this.rng, 1.5, 4);
      case 'thinking':
        return between(this.rng, 2, 3.5);
      case 'idle':
        return between(this.rng, 3, 7);
      default:
        return Infinity; // listening holds eye contact; only micro-saccades
    }
  }

  private schedule(dt: number): void {
    if (this.glanceLeft > 0) this.glanceLeft -= dt;
    if (!this.saccadesEnabled) {
      this.sacYaw = this.sacPitch = 0;
      return;
    }
    this.sacWait -= dt;
    if (this.sacWait <= 0) {
      this.sacWait = nextSaccadeMs(this.rng) / 1000;
      if (this.rng() < MICRO_RECENTRE) {
        this.sacYaw = this.sacPitch = 0;
      } else {
        const mag = between(this.rng, MICRO_MIN, MICRO_MAX);
        // Mostly sideways: within ±40° of horizontal, either side.
        const ang = between(this.rng, -40, 40) * DEG + (this.rng() < 0.5 ? Math.PI : 0);
        this.sacYaw = mag * Math.cos(ang);
        this.sacPitch = mag * Math.sin(ang);
      }
    }
    if (this.glanceLeft <= 0 && this.glanceWait !== Infinity) {
      this.glanceWait -= dt;
      if (this.glanceWait <= 0) {
        this.glanceWait = this.nextGlanceWait();
        const side = this.rng() < 0.5 ? -1 : 1;
        const big = this.mode === 'idle' ? between(this.rng, 6, 15) : between(this.rng, 5, 12);
        const up = this.rng() < 0.4;
        const yaw = (up ? 0.4 : 1) * side * big * DEG;
        const pitch = (up ? big * 0.8 : between(this.rng, -2, 3)) * DEG;
        this.glance(yaw, pitch, between(this.rng, 0.4, 1.2), 0.2);
      }
    }
  }
}
