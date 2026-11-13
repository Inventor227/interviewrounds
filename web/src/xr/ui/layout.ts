// Where the panels go. In the headset they are placed in the desk frame: the round bar below the
// sheet's near-right edge tilted 35° toward the user, the brief card on the sheet's top-left corner, the status and
// summary cards standing at eye level across the desk, captions low between the sheet and the interviewer.
// In the 2D preview the chrome rides with the camera like a HUD so the mouse can reach it.

import { addScaled, DEG, forwardOf, rightOf, v3, type Vec3 } from '../math';
import type { HeadPose } from '../placement';
import { SHEET_D, SHEET_TILT, SHEET_W, sheetPoint, userPoint, type DeskFrame } from '../seats';

export interface PanelPose {
  pos: Vec3;
  /** Euler YXZ: yaw about +Y, then tilt about local X (negative leans the top away from the user). */
  yaw: number;
  tilt: number;
  scale?: number;
}

export type PanelName = 'roundBar' | 'brief' | 'status' | 'summary' | 'captions';

/** Panel sizes in metres (for layout margins). */
const BRIEF_W = 0.3;
const BRIEF_H = 0.12;

export function layoutDesk(desk: DeskFrame): Record<PanelName, PanelPose> {
  const f = forwardOf(desk.yaw);
  const r = rightOf(desk.yaw);
  const o = v3(desk.origin.x, desk.deskY, desk.origin.z);
  // Cards measure from the real head when placement saw it, else from a seated eye 0.45 m above the desk.
  const eye = desk.head ? v3(desk.head.x, desk.head.y, desk.head.z) : v3(userPoint(desk).x, desk.deskY + 0.45, userPoint(desk).z);
  /** A card `ahead` metres in front of the eyes (horizontally) and `below` metres under them, tilted to face them. */
  const facingEyes = (ahead: number, below: number): PanelPose => {
    const p = addScaled(eye, f, ahead);
    return { pos: v3(p.x, eye.y - below, p.z), yaw: desk.yaw, tilt: -Math.atan2(below, ahead) };
  };
  const bar = addScaled(addScaled(o, r, 0.17), f, -0.08);
  return {
    roundBar: { pos: v3(bar.x, desk.deskY + 0.035, bar.z), yaw: desk.yaw, tilt: -55 * DEG },
    brief: {
      pos: sheetPoint(desk, -SHEET_W / 2 + BRIEF_W / 2 + 0.012, SHEET_D - BRIEF_H / 2 - 0.012, 0.006),
      yaw: desk.yaw,
      tilt: -(90 * DEG - SHEET_TILT),
    },
    // Cards with buttons sit in direct touch reach (about 0.44 m, below the eyes), never in the 0.5 to 0.8 m zone
    // where poke and ray get confused (Meta hands UI guidance).
    status: facingEyes(0.36, 0.25),
    summary: facingEyes(0.36, 0.25),
    // Captions about 1 m away, just below the lead interviewer's chin (Meta caption guidance).
    captions: facingEyes(0.96, 0.2),
  };
}

/** How far the brief card leans back in a round with a board (from upright): low and flat, like a propped card. */
export const BRIEF_BEYOND_TILT = 50 * DEG;
/** Its right edge stays this far left of the sheet's centre line, clear of the lead's hands and chest. */
export const BRIEF_BEYOND_CLEAR = 0.1;

/**
 * The brief card in a round with a board: propped just beyond the sheet's far edge, to the left of the lead (whose
 * hands rest at the centre) and well inside the next seat (0.75 m to the side), leaning back so it stays low. The
 * whole sheet stays free for drawing, and the card never stands in front of anyone's chest or hands.
 */
export function layoutBriefBeyondSheet(desk: DeskFrame): PanelPose {
  const u = -BRIEF_BEYOND_CLEAR - BRIEF_W / 2;
  // Leaning back, its lower edge comes toward the user: the centre sits far enough out that the lower edge stays
  // just past the sheet's far edge and covers none of it.
  const edge = sheetPoint(desk, u, SHEET_D + 0.004 + (BRIEF_H / 2) * Math.sin(BRIEF_BEYOND_TILT), 0);
  const rise = (BRIEF_H / 2) * Math.cos(BRIEF_BEYOND_TILT);
  return { pos: v3(edge.x, edge.y + rise + 0.008, edge.z), yaw: desk.yaw, tilt: -BRIEF_BEYOND_TILT };
}

/** The status card before the desk is known: in front of the head, a little low. */
export function layoutHeadStatus(head: HeadPose): PanelPose {
  // Low in view, where the eyes go when told to touch the desk; tilted to face the eyes.
  const p = addScaled(head.pos, forwardOf(head.yaw), 0.6);
  return { pos: v3(p.x, head.pos.y - 0.26, p.z), yaw: head.yaw, tilt: -24 * DEG };
}

/** A hint line: 0.6 m ahead, a little under the eye line. */
export function layoutHint(head: HeadPose): PanelPose {
  const p = addScaled(head.pos, forwardOf(head.yaw), 0.6);
  return { pos: v3(p.x, head.pos.y - 0.1, p.z), yaw: head.yaw, tilt: -9 * DEG };
}

/** Camera-local poses for the preview HUD, for a camera with this aspect and vertical field of view. */
export function layoutHud(aspect: number, vfovDeg: number): Partial<Record<PanelName, PanelPose>> {
  const d = 0.62;
  const halfH = d * Math.tan((vfovDeg * DEG) / 2);
  const halfW = halfH * aspect;
  // Shrink a little on narrow windows so the bar always fits.
  const s = Math.min(1, (halfW * 2 * 0.62) / 0.48);
  return {
    roundBar: { pos: v3(0, -halfH + 0.05 * s, -d), yaw: 0, tilt: 0, scale: s },
    brief: { pos: v3(-halfW + 0.18 * s, halfH - 0.105 * s, -d), yaw: 0, tilt: 0, scale: s },
    captions: { pos: v3(0, -halfH + 0.13 * s, -d), yaw: 0, tilt: 0, scale: s },
  };
}
