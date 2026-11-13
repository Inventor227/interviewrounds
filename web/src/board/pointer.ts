// One pointer model for the board: every active input source (a tracked hand or a held controller) is a pointer
// with a tip, an optional aim ray and a pressed state. Hands pinch (the pinch point is the midpoint of thumb and
// index tips, projected onto the sheet). Controllers pull the trigger: with the tip on or just above the sheet they
// draw directly (near); from further away the aim ray's hit on the sheet draws and picks (far), under a cursor dot.
// Each kind has its own smoothing and settle profile: a controller is steadier than a pinch, so it is smoothed less.
import type { Vec3 } from './port';

export type PointerSide = 'left' | 'right';
export type PointerKind = 'hand' | 'controller';

/** One input source this frame. */
export interface BoardPointer {
  hand: PointerSide;
  kind: PointerKind;
  /** Hands: the pinch point. Controllers: the front tip of the controller, where its aim ray starts. */
  tip: Vec3;
  /** Controllers only: the aim ray (unit direction). */
  ray: { origin: Vec3; dir: Vec3 } | null;
  /** A pinch or the trigger is held on the board. */
  pressed: boolean;
}

/** How a pointer kind is smoothed and how its press settles. Distances in board cm, times in ms. */
export interface PointerProfile {
  /** One Euro filter on the pointer's world point (metres): lower cutoff smooths more, beta frees fast moves. */
  minCutoff: number;
  beta: number;
  /** Right after a press the point is held this long (fingers closing, the trigger's jerk)... */
  settleMs: number;
  /** ...and movement under this in that time is taken off later moves, so a tap stays a tap. */
  driftMaxCm: number;
  /** A release lands where the pointer was this long before (fingers opening, the trigger letting go). */
  releaseTrimMs: number;
}

/** A pinch: jittery joints, a pinch point that slides about 2 cm as the fingers close (research 06 §1.1). */
export const HAND_PROFILE: PointerProfile = { minCutoff: 1.0, beta: 10, settleMs: 100, driftMaxCm: 2.5, releaseTrimMs: 80 };
/** A controller tip on the sheet: tracked to well under a millimetre, so smooth lightly and settle briefly. */
export const CONTROLLER_NEAR_PROFILE: PointerProfile = { minCutoff: 4.0, beta: 30, settleMs: 50, driftMaxCm: 0.8, releaseTrimMs: 40 };
/**
 * A controller's ray from a distance: the wrist's small turns grow with the distance (1 degree is about 0.9 cm at
 * arm's length), and the trigger pull tips the controller a little. More smoothing than the tip, less than a pinch.
 */
export const CONTROLLER_FAR_PROFILE: PointerProfile = { minCutoff: 2.0, beta: 14, settleMs: 70, driftMaxCm: 1.5, releaseTrimMs: 50 };

/** A controller's tip draws directly when it is this close above the sheet (cm), or slightly below it. */
export const CONTROLLER_NEAR_CM = 3;
/** The aim ray reaches the sheet from at most this far (m): the sheet is on the desk in front of the user. */
export const CONTROLLER_RAY_MAX_M = 1.5;

export function profileFor(kind: PointerKind, far: boolean): PointerProfile {
  if (kind === 'hand') return HAND_PROFILE;
  return far ? CONTROLLER_FAR_PROFILE : CONTROLLER_NEAR_PROFILE;
}

/** Light, short pulses for a controller; names follow what happened on the board or a panel. */
export type HapticName = 'press' | 'snap' | 'connect' | 'bin';
