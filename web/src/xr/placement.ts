// Desk placement: "Touch your desk where the sheet should go."
//
// An index fingertip that rests still on the desk for 0.6 s sets the desk: its height (minus the finger pad) is the
// desk top, the tip is the near edge centre of the sheet, and the head's yaw at that moment is the facing. With no
// touch within 6 s we fall back to a typical seated desk height below the head. Pure logic here; the world wires it
// to hand joints, draws the ring and anchors the result.

import { addScaled, forwardOf, type Vec3 } from './math';

/** Rest window and limits (research/06 §2.2). */
export const DWELL_MS = 600;
export const DWELL_MAX_SPEED = 0.02; // m/s
/** A tip must be this far below the head to count (keeps gestures near the face out). */
export const DWELL_BELOW_HEAD = 0.25;
/** The finger pad: the tip joint sits this far above the surface it rests on. */
export const FINGER_PAD = 0.008;
export const FALLBACK_MS = 6000;
/** Typical seated eye-to-desk height. */
export const FALLBACK_DESK_BELOW_HEAD = 0.45;
/** Where the sheet's near edge lands in front of the head when we fall back. */
export const FALLBACK_SHEET_AHEAD = 0.2;

/** Jitter allowance: a resting tip may wander this far from the window centroid. */
const DWELL_MAX_SPREAD = 0.012;
/** Another fingertip of the same hand lower than the index tip by more than this disqualifies it. */
const LOWEST_TOLERANCE = 0.005;

export interface DwellSample {
  t_ms: number;
  tip: Vec3;
  headY: number;
  /** All fingertips of the same hand, when known; the index tip must be the lowest. */
  tips?: Vec3[];
}

export interface DeskDwell {
  deskY: number;
  at: Vec3;
}

function sampleOk(s: DwellSample): boolean {
  if (!(s.tip.y < s.headY - DWELL_BELOW_HEAD)) return false;
  if (s.tips) for (const o of s.tips) if (o.y < s.tip.y - LOWEST_TOLERANCE) return false;
  return true;
}

/** Centroid (and mean time) of the samples in [from, to] by index. */
function centroid(samples: readonly DwellSample[], from: number, to: number): { p: Vec3; t: number } {
  let x = 0;
  let y = 0;
  let z = 0;
  let t = 0;
  const k = to - from + 1;
  for (let j = from; j <= to; j++) {
    const s = samples[j]!;
    x += s.tip.x;
    y += s.tip.y;
    z += s.tip.z;
    t += s.t_ms;
  }
  return { p: { x: x / k, y: y / k, z: z / k }, t: t / k };
}

/** Speed is measured between the centroids of the first and last 100 ms, so tracking jitter averages out. */
const SPEED_EDGE_MS = 100;
/** Below this window length the speed estimate is too noisy; the spread check covers it. */
const SPEED_MIN_WINDOW_MS = 200;

/**
 * How long (ms) the newest samples have been a resting desk touch. Walks back from the newest sample while the
 * window [i..last] stays still: speed under 2 cm/s and no wander beyond the jitter allowance.
 */
export function restingMs(samples: readonly DwellSample[]): { ms: number; at: Vec3 | null } {
  const n = samples.length;
  if (n === 0) return { ms: 0, at: null };
  const last = samples[n - 1]!;
  if (!sampleOk(last)) return { ms: 0, at: null };
  let newFrom = n - 1;
  while (newFrom > 0 && samples[newFrom - 1]!.t_ms >= last.t_ms - SPEED_EDGE_MS) newFrom--;
  const newest = centroid(samples, newFrom, n - 1);
  let sx = last.tip.x;
  let sy = last.tip.y;
  let sz = last.tip.z;
  let best = 0;
  let bestAt: Vec3 = { ...last.tip };
  for (let i = n - 2; i >= 0; i--) {
    const s = samples[i]!;
    if (!sampleOk(s)) break;
    sx += s.tip.x;
    sy += s.tip.y;
    sz += s.tip.z;
    const k = n - i;
    const c = { x: sx / k, y: sy / k, z: sz / k };
    const dt = last.t_ms - s.t_ms;
    if (dt <= 0) continue;
    if (dt >= SPEED_MIN_WINDOW_MS) {
      let oldTo = i;
      while (oldTo < n - 1 && samples[oldTo + 1]!.t_ms <= s.t_ms + SPEED_EDGE_MS) oldTo++;
      const oldest = centroid(samples, i, oldTo);
      const gap = Math.hypot(newest.p.x - oldest.p.x, newest.p.y - oldest.p.y, newest.p.z - oldest.p.z);
      const span = newest.t - oldest.t;
      if (span > 0 && (gap / span) * 1000 >= DWELL_MAX_SPEED) break;
    }
    let spread = 0;
    for (let j = i; j < n; j++) {
      const t = samples[j]!.tip;
      spread = Math.max(spread, Math.hypot(t.x - c.x, t.y - c.y, t.z - c.z));
    }
    if (spread > DWELL_MAX_SPREAD) break;
    best = dt;
    bestAt = c;
  }
  return { ms: best, at: bestAt };
}

/** The resting touch, once the newest samples have rested for 0.6 s; else null. */
export function detectDeskDwell(samples: readonly DwellSample[]): DeskDwell | null {
  const r = restingMs(samples);
  if (r.ms < DWELL_MS || !r.at) return null;
  // Use the lowest point of the rest as the contact height (the pad presses down a little over time).
  let minY = Infinity;
  for (const s of samples) if (s.t_ms >= samples[samples.length - 1]!.t_ms - r.ms) minY = Math.min(minY, s.tip.y);
  return { deskY: minY - FINGER_PAD, at: { x: r.at.x, y: minY - FINGER_PAD, z: r.at.z } };
}

export interface HandState {
  hand: 'left' | 'right';
  tracked: boolean;
  /** Index fingertip in world space. */
  indexTip: Vec3;
  /** All five fingertips (thumb..pinky) when tracked. */
  tips: Vec3[];
  /** 0..1, thumb to index distance mapped (1 = pinched). */
  pinch: number;
}

export interface HeadPose {
  pos: Vec3;
  /** Radians, CCW from above; 0 looks down -Z. */
  yaw: number;
  /** Radians; positive looks up. */
  pitch: number;
}

/** Where the desk is: the sheet's near edge centre (on the desk top), the facing, and the desk height. */
export interface DeskPose {
  origin: Vec3;
  yaw: number;
  deskY: number;
  source: 'touch' | 'fallback' | 'preview';
  /** The head at placement time, when known (cards that stand in front of the eyes use it). */
  head?: Vec3;
}

export type PlacementState = 'waiting' | 'dwelling' | 'done';

export interface PlacementStatus {
  state: PlacementState;
  /** 0..1 ring fill while dwelling. */
  progress: number;
  /** The tip being watched, for drawing the ring. */
  tip: Vec3 | null;
  hand: 'left' | 'right' | null;
  result: DeskPose | null;
}

/** Fallback desk pose from the head alone. */
export function fallbackDesk(head: HeadPose): DeskPose {
  const deskY = head.pos.y - FALLBACK_DESK_BELOW_HEAD;
  const o = addScaled({ x: head.pos.x, y: deskY, z: head.pos.z }, forwardOf(head.yaw), FALLBACK_SHEET_AHEAD);
  return { origin: o, yaw: head.yaw, deskY, source: 'fallback', head: { ...head.pos } };
}

/**
 * Feeds hand and head poses each frame; finishes on a 0.6 s rest of either index tip, or falls back at 6 s
 * unless a rest is under way.
 */
export class DeskPlacement {
  private readonly hist: Record<'left' | 'right', DwellSample[]> = { left: [], right: [] };
  private result: DeskPose | null = null;

  constructor(
    private readonly startMs: number,
    private readonly fallbackMs = FALLBACK_MS,
  ) {}

  get done(): boolean {
    return this.result !== null;
  }

  update(t_ms: number, head: HeadPose, hands: readonly HandState[]): PlacementStatus {
    if (this.result) return { state: 'done', progress: 1, tip: this.result.origin, hand: null, result: this.result };
    let bestProgress = 0;
    let bestTip: Vec3 | null = null;
    let bestHand: 'left' | 'right' | null = null;
    const seen = new Set<string>();
    for (const h of hands) {
      if (!h.tracked) continue;
      seen.add(h.hand);
      const hist = this.hist[h.hand];
      hist.push({ t_ms, tip: { ...h.indexTip }, headY: head.pos.y, tips: h.tips.length ? h.tips.map((p) => ({ ...p })) : undefined });
      // Keep a little more than the window.
      while (hist.length > 2 && hist[0]!.t_ms < t_ms - DWELL_MS * 2) hist.shift();
      const dwell = detectDeskDwell(hist);
      if (dwell) {
        this.result = { origin: dwell.at, yaw: head.yaw, deskY: dwell.deskY, source: 'touch', head: { ...head.pos } };
        return { state: 'done', progress: 1, tip: dwell.at, hand: h.hand, result: this.result };
      }
      const rest = restingMs(hist);
      const p = Math.min(1, rest.ms / DWELL_MS);
      if (rest.at && (p > bestProgress || !bestTip)) {
        bestProgress = p;
        bestTip = h.indexTip;
        bestHand = h.hand;
      }
    }
    for (const k of ['left', 'right'] as const) if (!seen.has(k)) this.hist[k].length = 0;

    const dwelling = bestProgress > 0;
    if (!dwelling && t_ms - this.startMs >= this.fallbackMs) {
      this.result = fallbackDesk(head);
      return { state: 'done', progress: 1, tip: null, hand: null, result: this.result };
    }
    return { state: dwelling ? 'dwelling' : 'waiting', progress: bestProgress, tip: bestTip, hand: bestHand, result: null };
  }
}
