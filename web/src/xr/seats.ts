// Seat layout across the user's desk, plus the other desk-relative frames (table slab, sheet, wall board).
// Pure math in the desk frame; room.ts turns it into meshes and the avatar runtime places people on SeatPose.
//
// The desk frame: origin = the sheet's near edge centre on the desk top (where the fingertip rested), yaw = the
// user's facing. The user's head sits about 0.20 m behind the origin (the sheet's near edge lies 0.20 m in front of
// a seated user, in easy reach).

import { add, addScaled, DEG, forwardOf, rightOf, v3, type Vec3 } from './math';
import type { DeskPose } from './placement';

export type DeskFrame = Pick<DeskPose, 'origin' | 'yaw' | 'deskY'> & { head?: DeskPose['head']; source?: DeskPose['source'] };

/** Desk height the seated clips were authored at: hands land on a 0.74 m desk with the root on the floor. */
export const AVATAR_DESK_Y = 0.74;
/** Seated eye height above the avatar root (manifest: 1.29 to 1.32 m). */
export const AVATAR_EYE_Y = 1.29;
/** Head-to-sheet distance: the sheet's near edge is this far in front of the user. */
export const USER_TO_ORIGIN = 0.2;
/** The lead sits straight across, this far from the user. */
export const LEAD_DISTANCE = 1.2;
/** Other panelists sit this far to each side of the lead... */
export const SIDE_OFFSET = 0.75;
/** ...turned this far toward the user. */
export const SIDE_TURN = 12 * DEG;
/** The avatar's own table edge is this far in front of its root (clips authored that way). */
export const AVATAR_TO_TABLE_EDGE = 0.25;
/** Assumed far edge of the real desk, beyond the origin. The slab starts a little before it and covers the seam. */
export const REAL_DESK_FAR = 0.42;

export interface SeatPose {
  /** 0 = lead (straight across), 1 = left of the lead, 2 = right of the lead (as the user sees them). */
  seat: 0 | 1 | 2;
  lead: boolean;
  /** Avatar root (between the feet, on its floor). Its floor is AVATAR_DESK_Y below the desk top. */
  pos: Vec3;
  /** Turn of the avatar about +Y; the avatar's front (local +Z) faces the user at the lead seat. */
  yaw: number;
  /** Where the eyes are with the seated clip, for gaze and the head sampler. */
  eye: Vec3;
}

/** Where the user's head is on the floor plane (y = desk height). */
export function userPoint(desk: DeskFrame): Vec3 {
  return addScaled(v3(desk.origin.x, desk.deskY, desk.origin.z), forwardOf(desk.yaw), -USER_TO_ORIGIN);
}

/**
 * Seats for 1 to 3 people. Lead straight across at 1.2 m from the user; others ±0.75 m to the side, turned 12°
 * toward the user. With 2 people the second sits to the user's left (the right side holds the round bar).
 */
export function seatLayout(n: 1 | 2 | 3, desk: DeskFrame): SeatPose[] {
  const f = forwardOf(desk.yaw);
  const r = rightOf(desk.yaw);
  const user = userPoint(desk);
  const rootY = desk.deskY - AVATAR_DESK_Y;
  const lead = addScaled(user, f, LEAD_DISTANCE);
  const mk = (seat: 0 | 1 | 2, side: -1 | 0 | 1): SeatPose => {
    const p = addScaled(lead, r, side * SIDE_OFFSET);
    // Facing the user is yaw = desk.yaw; turning toward -r (for a seat on the right) lowers the yaw.
    const yaw = desk.yaw - side * SIDE_TURN;
    const pos = v3(p.x, rootY, p.z);
    return { seat, lead: seat === 0, pos, yaw, eye: v3(p.x, rootY + AVATAR_EYE_Y, p.z) };
  };
  const seats = [mk(0, 0)];
  if (n >= 2) seats.push(mk(1, -1));
  if (n >= 3) seats.push(mk(2, 1));
  return seats;
}

export interface SlabFrame {
  /** Centre of the slab's top face. */
  center: Vec3;
  yaw: number;
  /** Across the user (along the desk's right axis). */
  width: number;
  /** Along the facing. */
  depth: number;
}

/** The slab's far edge (under the panelists' forearms), beyond the sheet's near edge. */
export const SLAB_FAR = LEAD_DISTANCE - USER_TO_ORIGIN - AVATAR_TO_TABLE_EDGE + 0.02;

/** Without a real desk (fallback) the slab is the whole desk: it starts this far behind the sheet's near edge. */
export const FULL_DESK_NEAR = -0.32;

/**
 * The virtual table slab: from just before the real desk's far edge to under the panelists' hands. With no real
 * desk (the head-height fallback) it reaches back under the sheet and the user's forearms instead.
 */
export function tableSlab(n: 1 | 2 | 3, desk: DeskFrame): SlabFrame {
  const near = desk.source === 'fallback' ? FULL_DESK_NEAR : REAL_DESK_FAR;
  const far = SLAB_FAR;
  const width = n === 1 ? 1.5 : n === 2 ? 2.3 : 2.6;
  const center = addScaled(v3(desk.origin.x, desk.deskY, desk.origin.z), forwardOf(desk.yaw), (near + far) / 2);
  // With two people the table shifts toward the occupied left side.
  const shifted = n === 2 ? addScaled(center, rightOf(desk.yaw), -SIDE_OFFSET / 2) : center;
  return { center: shifted, yaw: desk.yaw, width, depth: far - near };
}

export interface BoardFrame {
  /** Centre of the surface. */
  pos: Vec3;
  /** Front (local +Z) faces the user. */
  yaw: number;
  width: number;
  height: number;
}

/** Wall whiteboard, 1.6 × 1.0 m, standing behind the panel; its bottom edge is near the panelists' eye line. */
export function wallboardPose(desk: DeskFrame): BoardFrame {
  const p = addScaled(userPoint(desk), forwardOf(desk.yaw), LEAD_DISTANCE + 0.95);
  return { pos: v3(p.x, desk.deskY + 1.02, p.z), yaw: desk.yaw, width: 1.6, height: 1.0 };
}

/** Sheet size and tilt: 64 × 40 cm, lifted 2 cm, far edge raised 15° toward the user to ease neck and reading. */
export const SHEET_W = 0.64;
export const SHEET_D = 0.4;
export const SHEET_LIFT = 0.02;
export const SHEET_TILT = 15 * DEG;

/**
 * A point on the tilted sheet: u to the right of the near edge centre, v from the near edge toward the far edge
 * (along the tilted surface), lifted h off the surface.
 */
export function sheetPoint(desk: DeskFrame, u: number, v: number, h = 0): Vec3 {
  const f = forwardOf(desk.yaw);
  const r = rightOf(desk.yaw);
  const c = Math.cos(SHEET_TILT);
  const s = Math.sin(SHEET_TILT);
  const base = v3(desk.origin.x, desk.deskY + SHEET_LIFT, desk.origin.z);
  // Surface normal of the tilted sheet: up tilted back toward the user.
  const n = add(scaleUp(c), scaleVec(f, -s));
  return addScaled(addScaled(add(base, scaleVec(r, u)), add(scaleVec(f, v * c), scaleUp(v * s)), 1), n, h);
}

function scaleVec(a: Vec3, k: number): Vec3 {
  return v3(a.x * k, a.y * k, a.z * k);
}
function scaleUp(k: number): Vec3 {
  return v3(0, k, 0);
}
