// Where the panels go. In the headset they are placed in the desk frame (research/06 §2.1): the round bar below the
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
  // Cards that stand before the eyes measure from the real head when placement saw it.
  const user = desk.head ? v3(desk.head.x, desk.deskY, desk.head.z) : userPoint(desk);
  const standing = (ahead: number, up: number, tiltDeg: number): PanelPose => {
    const p = addScaled(user, f, ahead);
    return { pos: v3(p.x, desk.deskY + up, p.z), yaw: desk.yaw, tilt: -tiltDeg * DEG };
  };
  const bar = addScaled(addScaled(o, r, 0.17), f, -0.08);
  return {
    roundBar: { pos: v3(bar.x, desk.deskY + 0.035, bar.z), yaw: desk.yaw, tilt: -55 * DEG },
    brief: {
      pos: sheetPoint(desk, -SHEET_W / 2 + BRIEF_W / 2 + 0.012, SHEET_D - BRIEF_H / 2 - 0.012, 0.006),
      yaw: desk.yaw,
      tilt: -(90 * DEG - SHEET_TILT),
    },
    // Close enough that 1.5 cm type reads like 1.1 cm caps at arm's length; just under the eye line.
    status: standing(0.56, 0.36, 10),
    summary: standing(0.56, 0.34, 10),
    captions: { ...standing(0.66, 0.1, 25) },
  };
}

/** The status card before the desk is known: in front of the head, a little low. */
export function layoutHeadStatus(head: HeadPose): PanelPose {
  // Low in view, where the eyes go when told to touch the desk; tilted to face the eyes.
  const p = addScaled(head.pos, forwardOf(head.yaw), 0.6);
  return { pos: v3(p.x, head.pos.y - 0.26, p.z), yaw: head.yaw, tilt: -24 * DEG };
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
