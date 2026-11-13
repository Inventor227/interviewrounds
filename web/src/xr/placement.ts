// Desk placement: "Touch your desk with one finger", or with a controller's tip.
//
// An index fingertip that rests still on the desk for 0.6 s sets the desk: its height (minus the finger pad) is the
// desk top, the tip is the near edge centre of the sheet, and the head's yaw at that moment is the facing. A
// controller does the same with its front tip, resting on the desk and pointing down at it: once the tip has been
// still for 0.3 s a trigger pull places at once, and without the trigger the same 0.6 s rest as a finger does. A
// trigger pulled in the air, on the move, with the controller level, or while its ray is on a card or a button (the
// usual way to "click" something) never places. The tip is where the controller's aim ray starts, the
// front face of the controller body, so the desk top is the tip minus a few millimetres, not the grip 5 cm behind it.
// With no touch within 6 s (wall clock) we fall back to a typical seated desk height below the head; only a rest that
// is at least half done when the clock runs out may finish, and never past a hard cap. A desk candidate must sit in a
// plausible band below the eyes, so a hand or a controller resting in the lap is not a desk. Pure logic here; the
// world wires it to hand joints and controller poses, draws the ring and anchors the result.

import { addScaled, forwardOf, type Vec3 } from './math';

/** Rest window and limits: a short, deliberate touch, so tracking jitter and passing hands do not count. */
export const DWELL_MS = 600;
export const DWELL_MAX_SPEED = 0.02; // m/s
/** A tip must be at least this far below the head (keeps gestures near the face out)... */
export const DWELL_BELOW_HEAD = 0.25;
/** ...and at most this far (a hand resting on the lap or a knee is not a desk). */
export const DWELL_MAX_BELOW_HEAD = 0.75;
/** A rest at least this far along when the fallback clock runs out may still finish... */
export const HOLD_OFF_PROGRESS = 0.5;
/** ...but the wait never runs longer than this past the fallback time. */
export const FALLBACK_CAP_MS = 1500;
/** The finger pad: the tip joint sits this far above the surface it rests on. */
export const FINGER_PAD = 0.008;
/**
 * A controller's contact: its tip (the aim ray's origin) sits this far above the surface the controller's front
 * rests on. On Meta's Touch Plus model the front face is centred 4 mm from the ray origin (measured on the
 * controller model in aim-ray space); a tilted controller touches with the lower rim of that face.
 */
export const CONTROLLER_PAD = 0.005;
/**
 * A controller counts as resting on the desk (the dwell) only while it points down at least this much (the sine of
 * about 20 degrees): one lying in a lap or held level in the air is not touching a desk with its tip.
 */
export const CONTROLLER_DWELL_MIN_DOWN = 0.34;
/** The trigger places only when the controller's tip has rested this long (ms): a touch, not a wave. */
export const TRIGGER_STEADY_MS = 300;
export const FALLBACK_MS = 6000;
/** Typical seated eye-to-desk height. */
export const FALLBACK_DESK_BELOW_HEAD = 0.45;
/** Where the sheet's near edge lands in front of the head when we fall back. */
export const FALLBACK_SHEET_AHEAD = 0.2;

/** Jitter allowance: a resting tip may wander this far from the window centroid. */
const DWELL_MAX_SPREAD = 0.008;
/** Another fingertip of the same hand lower than the index tip by more than this disqualifies it. */
const LOWEST_TOLERANCE = 0.005;

export interface DwellSample {
  t_ms: number;
  tip: Vec3;
  headY: number;
  /** All fingertips of the same hand, when known; the index tip must be the lowest. */
  tips?: Vec3[];
}

/** A held controller as placement sees it. */
export interface ControllerTouch {
  hand: 'left' | 'right';
  tracked: boolean;
  /** The controller's front tip (the aim ray's origin) in world space. */
  tip: Vec3;
  /** The aim ray's direction (unit). */
  dir: Vec3;
  /** The trigger is held. */
  pressed: boolean;
  /** The aim ray is on a panel (the prompt card, a button): the trigger belongs to that, not to the desk. */
  busy?: boolean;
}

export interface DeskDwell {
  deskY: number;
  at: Vec3;
}

function sampleOk(s: DwellSample): boolean {
  if (!(s.tip.y < s.headY - DWELL_BELOW_HEAD) || !(s.tip.y > s.headY - DWELL_MAX_BELOW_HEAD)) return false;
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
export function detectDeskDwell(samples: readonly DwellSample[], rest = restingMs(samples), pad = FINGER_PAD): DeskDwell | null {
  const r = rest;
  if (r.ms < DWELL_MS || !r.at) return null;
  // Use the lowest point of the rest as the contact height (the pad presses down a little over time).
  let minY = Infinity;
  for (const s of samples) if (s.t_ms >= samples[samples.length - 1]!.t_ms - r.ms) minY = Math.min(minY, s.tip.y);
  return { deskY: minY - pad, at: { x: r.at.x, y: minY - pad, z: r.at.z } };
}

/** True when a tip is in the band below the eyes where a desk can be. */
export function inDeskBand(tipY: number, headY: number): boolean {
  return tipY < headY - DWELL_BELOW_HEAD && tipY > headY - DWELL_MAX_BELOW_HEAD;
}

export interface HandState {
  hand: 'left' | 'right';
  tracked: boolean;
  /** Index fingertip in world space. */
  indexTip: Vec3;
  /** Thumb tip in world space (the same object as tips[0] when tracked). */
  thumbTip: Vec3;
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
  /** The hand that touched the desk (or held the controller that did): the dominant side (the tray goes opposite). */
  hand?: 'left' | 'right';
  /** What touched the desk. */
  input?: 'hands' | 'controllers';
}

export type PlacementState = 'waiting' | 'dwelling' | 'done';

export interface PlacementStatus {
  state: PlacementState;
  /** 0..1 ring fill while dwelling. */
  progress: number;
  /** The tip being watched, for drawing the ring. */
  tip: Vec3 | null;
  /** How far that tip sits above the surface it rests on (a finger pad, a controller's front). */
  pad: number;
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
 * Feeds hand, controller and head poses each frame; finishes on a 0.6 s rest of either index tip or controller tip,
 * at once on a trigger pull with the controller's tip on the desk, or falls back at 6 s unless a rest is at least
 * half done (and never later than 6 s plus the cap).
 */
export class DeskPlacement {
  private readonly hist: Record<'left' | 'right', DwellSample[]> = { left: [], right: [] };
  /** Which kind of pointer each side's samples came from (a side that changes starts its rest again). */
  private readonly histKind: Record<'left' | 'right', 'hand' | 'controller' | null> = { left: null, right: null };
  /** The trigger as last seen per side; null until seen once, so a trigger already held does not count as a pull. */
  private readonly trigger: Record<'left' | 'right', boolean | null> = { left: null, right: null };
  private result: DeskPose | null = null;

  constructor(
    private readonly startMs: number,
    private readonly fallbackMs = FALLBACK_MS,
  ) {}

  get done(): boolean {
    return this.result !== null;
  }

  update(t_ms: number, head: HeadPose, hands: readonly HandState[], controllers: readonly ControllerTouch[] = []): PlacementStatus {
    if (this.result) return { state: 'done', progress: 1, tip: this.result.origin, pad: 0, hand: null, result: this.result };
    let bestProgress = 0;
    let bestTip: Vec3 | null = null;
    let bestPad = FINGER_PAD;
    let bestHand: 'left' | 'right' | null = null;
    const seen = { left: false, right: false };
    /** One side's tip this frame: keeps its rest history and finishes on a full rest. */
    const rest = (side: 'left' | 'right', kind: 'hand' | 'controller', tip: Vec3, tips: Vec3[] | undefined, pad: number, pulled = false): PlacementStatus | null => {
      seen[side] = true;
      const hist = this.hist[side];
      if (this.histKind[side] !== kind) hist.length = 0;
      this.histKind[side] = kind;
      hist.push({ t_ms, tip: { ...tip }, headY: head.pos.y, tips });
      // Keep the dwell window plus a little (the walk-back is quadratic in the samples kept).
      while (hist.length > 2 && hist[0]!.t_ms < t_ms - DWELL_MS - 150) hist.shift();
      const r = restingMs(hist);
      const dwell = detectDeskDwell(hist, r, pad);
      if (dwell) return this.finish(dwell.at, dwell.deskY, head, side, kind);
      // A controller's trigger, pulled once the tip has rested a moment: placed now, where it rests.
      if (pulled && r.at && r.ms >= TRIGGER_STEADY_MS) {
        let minY = Infinity;
        for (const s of hist) if (s.t_ms >= t_ms - r.ms) minY = Math.min(minY, s.tip.y);
        return this.finish({ x: r.at.x, y: minY - pad, z: r.at.z }, minY - pad, head, side, kind);
      }
      const p = Math.min(1, r.ms / DWELL_MS);
      if (r.at && (p > bestProgress || !bestTip)) {
        bestProgress = p;
        bestTip = tip;
        bestPad = pad;
        bestHand = side;
      }
      return null;
    };
    for (const h of hands) {
      if (!h.tracked) continue;
      const done = rest(h.hand, 'hand', h.indexTip, h.tips.length ? h.tips.map((p) => ({ ...p })) : undefined, FINGER_PAD);
      if (done) return done;
    }
    for (const c of controllers) {
      // A side with a tracked hand is a hand; its controller (lying on the desk, say) is not the pointer.
      if (!c.tracked || seen[c.hand]) continue;
      const was = this.trigger[c.hand];
      this.trigger[c.hand] = c.pressed;
      const pulled = c.pressed && was === false;
      // Only a controller that points down at the desk and is not aiming at a panel can be touching it: its tip is
      // then watched like a fingertip. Still for 0.3 s plus a trigger pull places; still for 0.6 s places by itself.
      if (c.dir.y > -CONTROLLER_DWELL_MIN_DOWN || c.busy) continue;
      const done = rest(c.hand, 'controller', c.tip, undefined, CONTROLLER_PAD, pulled);
      if (done) return done;
    }
    for (const side of ['left', 'right'] as const) {
      if (!seen[side]) {
        this.hist[side].length = 0;
        this.histKind[side] = null;
      }
      if (!controllers.some((c) => c.tracked && c.hand === side)) this.trigger[side] = null;
    }

    const dwelling = bestProgress > 0;
    // The clock runs regardless of hand motion; only a rest at least half done may hold it, up to the cap.
    const elapsed = t_ms - this.startMs;
    const holding = bestProgress >= HOLD_OFF_PROGRESS && elapsed < this.fallbackMs + FALLBACK_CAP_MS;
    if (elapsed >= this.fallbackMs && !holding) {
      this.result = fallbackDesk(head);
      return { state: 'done', progress: 1, tip: null, pad: 0, hand: null, result: this.result };
    }
    return { state: dwelling ? 'dwelling' : 'waiting', progress: bestProgress, tip: bestTip, pad: bestPad, hand: bestHand, result: null };
  }

  private finish(at: Vec3, deskY: number, head: HeadPose, hand: 'left' | 'right', kind: 'hand' | 'controller'): PlacementStatus {
    this.result = { origin: at, yaw: head.yaw, deskY, source: 'touch', head: { ...head.pos }, hand, input: kind === 'hand' ? 'hands' : 'controllers' };
    return { state: 'done', progress: 1, tip: at, pad: 0, hand, result: this.result };
  }
}
