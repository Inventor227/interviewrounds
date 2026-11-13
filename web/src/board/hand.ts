// Hands and controllers as board pointers, one per side (research 06 §2.3, pointer.ts).
// A hand: the pinch point is the midpoint of the thumb and index tips, One Euro filtered in
// metres, projected onto the tilted sheet. A controller: its tip projected the same way while
// it is on or just above the sheet (near), else the point where its aim ray meets the sheet
// (far). The press is the XR select event (selectstart / selectend): the system's pinch, or
// the trigger. Tracking loss mid gesture: the gesture freezes at the last good point for
// 300 ms; if the pointer comes back still pressed it carries on, otherwise it is cancelled
// (no op). A side that changes from a hand to a controller (or back) mid gesture ends it the
// same way at once: the new pointer starts idle and needs its own press.
import { OneEuroFilter } from './ink';
import { DRAG_THRESHOLD_CM, type BoardPoint, type CancelReason, type PointerAdapter } from './input';
import { SHEET, type Rect } from './model';
import { CONTROLLER_NEAR_CM, CONTROLLER_RAY_MAX_M, HAND_PROFILE, profileFor, type BoardPointer, type PointerKind, type PointerProfile } from './pointer';
import type { BoardXRPort, SelectPhase, Vec3, XRControllerSample, XRHandSample } from './port';

export const TRACKING_GRACE_MS = 300;
/**
 * The pinch point slides as the fingers finish closing after select fires (about 2 cm in
 * the emulator). For this long after a pinch starts, movement under PINCH_DRIFT_MAX_CM is
 * that drift: the point is held, then the drift is taken off later moves, so a tap stays a tap.
 */
export const PINCH_SETTLE_MS = HAND_PROFILE.settleMs;
export const PINCH_DRIFT_MAX_CM = HAND_PROFILE.driftMaxCm;
/** The fingers opening before select ends move the point too: release at where it was this long before. */
export const RELEASE_TRIM_MS = HAND_PROFILE.releaseTrimMs;
/** A pinch may start this far outside the zone (cm). */
export const ZONE_MARGIN_CM = 3;
/** A pinch starts only this close above the sheet (cm), or slightly below it. */
export const MAX_HEIGHT_CM = 12;
/** A hand hovers over (highlights, touches) what is under it only this close above the sheet (research 06 §2.3). */
export const HOVER_MAX_CM = 4;
/** Once a gesture is a drag, the closing-drift correction fades to zero over this long. */
export const DRIFT_FADE_MS = 150;
const MIN_HEIGHT_CM = -3;

type Side = 'left' | 'right';
type Projected = { x_cm: number; y_cm: number; h_cm: number };
type Cb = (p: BoardPoint, reason?: CancelReason) => void;

export interface HandPointer extends Projected {
  hand: Side;
  /** The pointer holds a gesture (pinched, or the trigger held, on the board). */
  pinched: boolean;
  kind: PointerKind;
  /** A controller pointing from a distance: its tip and where the aim ray lands (world), for the ray and its dot. */
  ray?: { from: Vec3; to: Vec3 };
}

export interface HandAdapterOptions {
  /** Board area where a pinch may start (board cm): the sheet plus tray and bin. Default: the sheet. */
  zone?: Rect;
  graceMs?: number;
  /** Where an aim ray meets the board (SurfaceProjector.cast). Without it controllers only draw with the tip. */
  cast?: (origin: Vec3, dir: Vec3) => { point: Vec3; dist: number } | null;
}

/** What a side's input source gives this frame: the world point over the board (null: not on it). */
interface Source {
  kind: PointerKind;
  far: boolean;
  raw: Vec3 | null;
  tip: Vec3;
  dir: Vec3 | null;
}

interface HandTrack {
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  fz: OneEuroFilter;
  /** The side's source: a hand or a controller (null before anything was seen). */
  kind: PointerKind | null;
  /** A controller pointing with its ray (not touching). Fixed for the length of a gesture. */
  far: boolean;
  profile: PointerProfile;
  /** Last good projected point (filtered). */
  last: Projected | null;
  /** The same point in world space, and the source's tip and aim this frame. */
  world: Vec3 | null;
  tip: Vec3 | null;
  dir: Vec3 | null;
  /** This frame's raw point (world), where a press starts. */
  raw: Vec3 | null;
  visible: boolean;
  /** Idle and within the hover band last frame (a leave is sent when that ends). */
  hovering: boolean;
  active: boolean;
  lostAt: number | null;
  /** The gesture: when and where it started, the closing drift taken off, the points sent. */
  downAt: number;
  downPoint: Projected | null;
  drift: { x: number; y: number } | null;
  /** When the gesture left tap range (the drift correction then fades out). */
  dragSince: number | null;
  sent: { t: number; p: Projected }[];
}

const track = (): HandTrack => ({
  fx: new OneEuroFilter(HAND_PROFILE.minCutoff, HAND_PROFILE.beta),
  fy: new OneEuroFilter(HAND_PROFILE.minCutoff, HAND_PROFILE.beta),
  fz: new OneEuroFilter(HAND_PROFILE.minCutoff, HAND_PROFILE.beta),
  kind: null,
  far: false,
  profile: HAND_PROFILE,
  last: null,
  world: null,
  tip: null,
  dir: null,
  raw: null,
  visible: false,
  hovering: false,
  active: false,
  lostAt: null,
  downAt: 0,
  downPoint: null,
  drift: null,
  dragSince: null,
  sent: [],
});

export class HandAdapter implements PointerAdapter {
  private readonly subs = { down: new Set<Cb>(), move: new Set<Cb>(), up: new Set<Cb>(), cancel: new Set<Cb>() };
  private readonly leaves = new Set<(hand: Side) => void>();
  private readonly hands: Record<Side, HandTrack> = { left: track(), right: track() };
  private readonly zone: Rect;
  private readonly graceMs: number;
  private readonly cast: HandAdapterOptions['cast'];
  private offs: (() => void)[];

  constructor(
    private readonly port: BoardXRPort,
    private readonly project: (p: Vec3) => Projected,
    opts: HandAdapterOptions = {},
  ) {
    this.zone = opts.zone ?? { x: 0, y: 0, w: SHEET.w, h: SHEET.h };
    this.graceMs = opts.graceMs ?? TRACKING_GRACE_MS;
    this.cast = opts.cast;
    this.offs = [port.onFrame((_dt, now) => this.frame(now)), port.onSelect((hand, phase, now, kind) => this.select(hand, phase, now, kind))];
    if (port.onSessionEnd) this.offs.push(port.onSessionEnd(() => this.sessionEnd()));
  }

  destroy(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
  }

  onDown(cb: Cb): () => void {
    this.subs.down.add(cb);
    return () => this.subs.down.delete(cb);
  }
  onMove(cb: Cb): () => void {
    this.subs.move.add(cb);
    return () => this.subs.move.delete(cb);
  }
  onUp(cb: Cb): () => void {
    this.subs.up.add(cb);
    return () => this.subs.up.delete(cb);
  }
  onLeave(cb: (hand: Side) => void): () => void {
    this.leaves.add(cb);
    return () => this.leaves.delete(cb);
  }
  onCancel(cb: (p: BoardPoint, reason?: CancelReason) => void): () => void {
    this.subs.cancel.add(cb);
    return () => this.subs.cancel.delete(cb);
  }

  /** Pointers over the board this frame (for the pinch shadow ring, and a controller's ray and dot). */
  pointers(): HandPointer[] {
    const out: HandPointer[] = [];
    for (const hand of ['left', 'right'] as const) {
      const t = this.hands[hand];
      if (!t.visible || !t.last || !(t.active || this.inZone(t.last))) continue;
      const p: HandPointer = { hand, ...t.last, pinched: t.active, kind: t.kind ?? 'hand' };
      if (t.far && t.tip && t.world) p.ray = { from: t.tip, to: t.world };
      out.push(p);
    }
    return out;
  }

  /** Every input source tracked this frame, on the board or not, in the one pointer model (pointer.ts). */
  sources(): BoardPointer[] {
    const out: BoardPointer[] = [];
    for (const hand of ['left', 'right'] as const) {
      const t = this.hands[hand];
      if (!t.kind || !t.tip) continue;
      out.push({ hand, kind: t.kind, tip: t.tip, ray: t.kind === 'controller' && t.dir ? { origin: t.tip, dir: t.dir } : null, pressed: t.active });
    }
    return out;
  }

  /** The kind of pointer a side has now: a hand, a controller, or nothing tracked. */
  kindOf(hand: Side): PointerKind | null {
    const t = this.hands[hand];
    return t.tip ? t.kind : null;
  }

  private emit(set: Set<Cb>, hand: Side, p: Projected, now: number, reason?: CancelReason): void {
    const bp: BoardPoint = { x_cm: p.x_cm, y_cm: p.y_cm, t_ms: now, hand };
    for (const cb of [...set]) cb(bp, reason);
  }

  /** An idle hand stopped hovering: the board clears its hover outline. */
  private leave(t: HandTrack, hand: Side): void {
    if (!t.hovering) return;
    t.hovering = false;
    for (const cb of [...this.leaves]) cb(hand);
  }

  /** The session ended: frames stop, so nothing is hovering and any gesture is lost. */
  private sessionEnd(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    for (const hand of ['left', 'right'] as const) {
      const t = this.hands[hand];
      if (t.active) this.lose(t, hand, now);
      this.leave(t, hand);
      t.visible = false;
      t.raw = null;
      t.tip = null;
      t.dir = null;
      t.kind = null;
      t.far = false;
    }
  }

  /** End a gesture that was lost: tracking gone past the grace, or the pinch cancelled. */
  private lose(t: HandTrack, hand: Side, now: number): void {
    t.active = false;
    t.lostAt = null;
    const at = t.sent[t.sent.length - 1]?.p ?? t.downPoint ?? t.last;
    if (at) this.emit(this.subs.cancel, hand, at, now, 'lost');
  }

  private inZone(p: Projected): boolean {
    const z = this.zone;
    const m = ZONE_MARGIN_CM;
    return p.x_cm >= z.x - m && p.x_cm <= z.x + z.w + m && p.y_cm >= z.y - m && p.y_cm <= z.y + z.h + m && p.h_cm > MIN_HEIGHT_CM && p.h_cm < MAX_HEIGHT_CM;
  }

  /** This side's source this frame: a tracked hand first, else a held controller. */
  private source(hand: Side, t: HandTrack, hands: XRHandSample[], ctrls: XRControllerSample[]): Source | null {
    const s = hands.find((h) => h.hand === hand);
    if (s && s.tracked && s.indexTip) {
      const a = s.indexTip;
      const b = s.thumbTip ?? s.indexTip;
      // The midpoint moves least as the fingers close (research 06 §1.1).
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      return { kind: 'hand', far: false, raw: mid, tip: mid, dir: null };
    }
    const c = ctrls.find((k) => k.hand === hand);
    if (!c || !c.tracked) return null;
    const base = { kind: 'controller' as const, tip: c.tip, dir: c.dir };
    // A gesture keeps the way it started: a stroke by touch stays on the tip, a stroke by ray stays on the ray.
    if (t.active && t.kind === 'controller') {
      if (!t.far) return { ...base, far: false, raw: c.tip };
      const hit = this.cast?.(c.tip, c.dir) ?? null;
      return { ...base, far: true, raw: hit ? hit.point : null };
    }
    const near = this.project(c.tip);
    if (this.inZone(near) && near.h_cm <= CONTROLLER_NEAR_CM) return { ...base, far: false, raw: c.tip };
    if (!c.busy && this.cast) {
      const hit = this.cast(c.tip, c.dir);
      if (hit && hit.dist <= CONTROLLER_RAY_MAX_M && this.inZone({ ...this.project(hit.point), h_cm: 0 })) return { ...base, far: true, raw: hit.point };
    }
    return { ...base, far: false, raw: null };
  }

  /** New filters for a pointer kind (and for a controller going between touch and ray). */
  private tune(t: HandTrack, kind: PointerKind, far: boolean): void {
    t.kind = kind;
    t.far = far;
    t.profile = profileFor(kind, far);
    t.fx = new OneEuroFilter(t.profile.minCutoff, t.profile.beta);
    t.fy = new OneEuroFilter(t.profile.minCutoff, t.profile.beta);
    t.fz = new OneEuroFilter(t.profile.minCutoff, t.profile.beta);
  }

  private frame(now: number): void {
    const all = this.port.hands();
    const ctrls = this.port.controllers?.() ?? [];
    for (const hand of ['left', 'right'] as const) {
      const t = this.hands[hand];
      const src = this.source(hand, t, all, ctrls);
      if (src && (src.kind !== t.kind || src.far !== t.far)) {
        // The side changed hands for a controller (or back): whatever the old pointer held ends here.
        if (t.kind !== null && src.kind !== t.kind) {
          if (t.active) this.lose(t, hand, now);
          this.leave(t, hand);
          t.visible = false;
          t.last = null;
          t.raw = null;
        }
        this.tune(t, src.kind, src.far);
      }
      if (src) {
        t.tip = src.tip;
        t.dir = src.dir;
      }
      if (src?.raw) {
        const raw = src.raw;
        t.raw = raw;
        const f = { x: t.fx.filter(raw.x, now), y: t.fy.filter(raw.y, now), z: t.fz.filter(raw.z, now) };
        const p = this.project(f);
        // A ray's point lies on the surface: it hovers and presses like a pointer touching it.
        t.last = src.far ? { ...p, h_cm: 0 } : p;
        t.world = f;
        t.visible = true;
        t.lostAt = null;
        if (t.active) this.emit(this.subs.move, hand, this.gesturePoint(t, t.last, now), now);
        else if (this.inZone(t.last) && t.last.h_cm < HOVER_MAX_CM) {
          t.hovering = true;
          this.emit(this.subs.move, hand, t.last, now);
        } else this.leave(t, hand);
        continue;
      }
      if (src) {
        // A tracked controller that is not on the board. Mid gesture (its ray left the sheet's plane) the
        // gesture waits at the last point: the trigger is still held and the controller is still tracked.
        t.lostAt = null;
        if (t.active) continue;
        t.visible = false;
        t.raw = null;
        this.leave(t, hand);
        t.fx.reset();
        t.fy.reset();
        t.fz.reset();
        continue;
      }
      // Nothing tracked this frame: hold the gesture at the last good point for the grace time.
      t.visible = false;
      t.raw = null;
      t.tip = null;
      t.dir = null;
      this.leave(t, hand);
      t.fx.reset();
      t.fy.reset();
      t.fz.reset();
      if (!t.active) continue;
      t.lostAt ??= now;
      if (now - t.lostAt > this.graceMs) this.lose(t, hand, now);
    }
  }

  private select(hand: Side, phase: SelectPhase, now: number, kind?: PointerKind): void {
    const t = this.hands[hand];
    // A select from a source that is not this side's pointer any more (a hand's pinch ending after a
    // controller was picked up): the gesture it belonged to has already ended.
    if (kind && t.kind && kind !== t.kind) return;
    if (phase === 'start') {
      if (t.active || !t.visible || !t.raw) return;
      // Start where the hand is now: the filter may still be catching up with a fast
      // arrival, and a pinch on a card's edge must not land in its middle. Smoothing goes
      // on from this point.
      const at = this.project(t.raw);
      const p = t.far ? { ...at, h_cm: 0 } : at;
      if (!this.inZone(p)) return;
      t.fx.reset();
      t.fy.reset();
      t.fz.reset();
      t.fx.filter(t.raw.x, now);
      t.fy.filter(t.raw.y, now);
      t.fz.filter(t.raw.z, now);
      t.last = p;
      t.world = t.raw;
      t.active = true;
      t.hovering = false;
      t.downAt = now;
      t.downPoint = p;
      t.drift = null;
      t.dragSince = null;
      t.sent = [];
      this.emit(this.subs.down, hand, p, now);
      return;
    }
    if (!t.active) return;
    // A selectend with no select: the system cancelled the pinch (often the hand is going away).
    if (phase === 'cancel') {
      this.lose(t, hand, now);
      return;
    }
    t.active = false;
    t.lostAt = null;
    // Release where the hand was before the fingers began to open; after a long hitch with
    // nothing that old, the oldest point kept, else the last.
    let at: Projected | null = null;
    for (const s of t.sent) if (s.t <= now - t.profile.releaseTrimMs) at = s.p;
    at ??= t.sent[0]?.p ?? t.last ?? t.downPoint;
    if (at) this.emit(this.subs.up, hand, at, now);
  }

  /** A gesture point with the pinch's closing drift held, then taken off. */
  private gesturePoint(t: HandTrack, p: Projected, now: number): Projected {
    const d = t.downPoint ?? p;
    let out: Projected;
    if (now - t.downAt < t.profile.settleMs) {
      out = { ...p, x_cm: d.x_cm, y_cm: d.y_cm };
    } else {
      if (!t.drift) {
        const dx = p.x_cm - d.x_cm;
        const dy = p.y_cm - d.y_cm;
        // A bigger move this early is the hand setting off, not drift.
        t.drift = Math.hypot(dx, dy) < t.profile.driftMaxCm ? { x: dx, y: dy } : { x: 0, y: 0 };
      }
      // The correction is for taps: once the gesture is a drag it fades out, so strokes and
      // drags catch up with the hand.
      let k = 1;
      if (t.dragSince === null && Math.hypot(p.x_cm - t.drift.x - d.x_cm, p.y_cm - t.drift.y - d.y_cm) >= DRAG_THRESHOLD_CM) t.dragSince = now;
      if (t.dragSince !== null) k = Math.max(0, 1 - (now - t.dragSince) / DRIFT_FADE_MS);
      out = { ...p, x_cm: p.x_cm - t.drift.x * k, y_cm: p.y_cm - t.drift.y * k };
    }
    t.sent.push({ t: now, p: out });
    while (t.sent.length && t.sent[0]!.t < now - 400) t.sent.shift();
    return out;
  }
}
