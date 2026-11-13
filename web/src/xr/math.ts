// Small vector helpers for the room layout. Plain objects so the layout code stays pure and testable.
//
// Conventions (three.js / WebXR local-floor): metres, +Y up, the user starts facing -Z.
// A yaw turns counter-clockwise seen from above; a camera with yaw 0 looks down -Z.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const DEG = Math.PI / 180;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));
/** a + b * s */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });

/** Horizontal direction a viewer with this yaw looks along. */
export const forwardOf = (yaw: number): Vec3 => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
/** Horizontal direction to that viewer's right. */
export const rightOf = (yaw: number): Vec3 => ({ x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) });

/** Yaw that makes an object whose front is local +Z face along dir (horizontal part). */
export const yawFacing = (dir: Vec3): number => Math.atan2(dir.x, dir.z);
/** Yaw of a viewer (front = -Z) looking along dir. */
export const yawLooking = (dir: Vec3): number => Math.atan2(-dir.x, -dir.z);
/** Pitch of a viewer looking along dir; positive is up. */
export const pitchLooking = (dir: Vec3): number => Math.atan2(dir.y, Math.hypot(dir.x, dir.z));

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  return w === -Math.PI ? Math.PI : w;
}

/** Unit view direction of a viewer with this yaw and pitch. */
export function viewDir(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

/** Angle between two vectors in radians. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const d = len(a) * len(b);
  if (d === 0) return Math.PI;
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / d;
  return Math.acos(Math.min(1, Math.max(-1, c)));
}

/** Yaw and pitch (radians) of a viewer from a rotation quaternion (YXZ order, as for a head). */
export function yawPitchFromQuat(q: { x: number; y: number; z: number; w: number }): { yaw: number; pitch: number } {
  // Forward vector of the rotated -Z axis.
  const { x, y, z, w } = q;
  const fx = -(2 * (x * z + w * y));
  const fy = -(2 * (y * z - w * x));
  const fz = -(1 - 2 * (x * x + y * y));
  return { yaw: Math.atan2(-fx, -fz), pitch: Math.atan2(fy, Math.hypot(fx, fz)) };
}
