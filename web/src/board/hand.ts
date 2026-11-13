// Hands as a board pointer (research 06 §2.3): per hand, the pinch point is the midpoint of
// the thumb and index tips, One Euro filtered in metres, projected onto the tilted sheet.
// The pinch itself is the XR select event (selectstart / selectend), which the system tunes.
// Tracking loss mid gesture: the gesture freezes at the last good point for 300 ms; if the
// hand comes back with the pinch still held it carries on, otherwise it is cancelled (no op).
import { OneEuroFilter } from './ink';
import { DRAG_THRESHOLD_CM, type BoardPoint, type CancelReason, type PointerAdapter } from './input';
import { SHEET, type Rect } from './model';
import type { BoardXRPort, SelectPhase, Vec3, XRHandSample } from './port';

export const TRACKING_GRACE_MS = 300;
/**
 * The pinch point slides as the fingers finish closing after select fires (about 2 cm in
 * the emulator). For this long after a pinch starts, movement under PINCH_DRIFT_MAX_CM is
 * that drift: the point is held, then the drift is taken off later moves, so a tap stays a tap.
 */
export const PINCH_SETTLE_MS = 100;
export const PINCH_DRIFT_MAX_CM = 2.5;
/** The fingers opening before select ends move the point too: release at where it was this long before. */
export const RELEASE_TRIM_MS = 80;
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
  /** The hand holds a gesture (pinched on the board). */
  pinched: boolean;
}

export interface HandAdapterOptions {
  /** Board area where a pinch may start (board cm): the sheet plus tray and bin. Default: the sheet. */
  zone?: Rect;
  graceMs?: number;
}

interface HandTrack {
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  fz: OneEuroFilter;
  /** Last good projected point (filtered). */
  last: Projected | null;
  /** This frame's raw pinch point (world), where a pinch starts. */
  raw: Vec3 | null;
  visible: boolean;
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

const track = (): HandTrack => ({ fx: new OneEuroFilter(), fy: new OneEuroFilter(), fz: new OneEuroFilter(), last: null, raw: null, visible: false, active: false, lostAt: null, downAt: 0, downPoint: null, drift: null, dragSince: null, sent: [] });

export class HandAdapter implements PointerAdapter {
  private readonly subs = { down: new Set<Cb>(), move: new Set<Cb>(), up: new Set<Cb>(), cancel: new Set<Cb>() };
  private readonly hands: Record<Side, HandTrack> = { left: track(), right: track() };
  private readonly zone: Rect;
  private readonly graceMs: number;
  private offs: (() => void)[];

  constructor(
    private readonly port: BoardXRPort,
    private readonly project: (p: Vec3) => Projected,
    opts: HandAdapterOptions = {},
  ) {
    this.zone = opts.zone ?? { x: 0, y: 0, w: SHEET.w, h: SHEET.h };
    this.graceMs = opts.graceMs ?? TRACKING_GRACE_MS;
    this.offs = [port.onFrame((_dt, now) => this.frame(now)), port.onSelect((hand, phase, now) => this.select(hand, phase, now))];
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
  onCancel(cb: (p: BoardPoint, reason?: CancelReason) => void): () => void {
    this.subs.cancel.add(cb);
    return () => this.subs.cancel.delete(cb);
  }

  /** Hands over the board this frame (for the pinch shadow ring). */
  pointers(): HandPointer[] {
    const out: HandPointer[] = [];
    for (const hand of ['left', 'right'] as const) {
      const t = this.hands[hand];
      if (t.visible && t.last && (t.active || this.inZone(t.last))) out.push({ hand, ...t.last, pinched: t.active });
    }
    return out;
  }

  private emit(set: Set<Cb>, hand: Side, p: Projected, now: number, reason?: CancelReason): void {
    const bp: BoardPoint = { x_cm: p.x_cm, y_cm: p.y_cm, t_ms: now, hand };
    for (const cb of [...set]) cb(bp, reason);
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

  private sample(hand: Side, all: XRHandSample[]): Vec3 | null {
    const s = all.find((h) => h.hand === hand);
    if (!s || !s.tracked || !s.indexTip) return null;
    const a = s.indexTip;
    const b = s.thumbTip ?? s.indexTip;
    // The midpoint moves least as the fingers close (research 06 §1.1).
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  }

  private frame(now: number): void {
    const all = this.port.hands();
    for (const hand of ['left', 'right'] as const) {
      const t = this.hands[hand];
      const raw = this.sample(hand, all);
      if (raw) {
        t.raw = raw;
        const f = { x: t.fx.filter(raw.x, now), y: t.fy.filter(raw.y, now), z: t.fz.filter(raw.z, now) };
        t.last = this.project(f);
        t.visible = true;
        t.lostAt = null;
        if (t.active) this.emit(this.subs.move, hand, this.gesturePoint(t, t.last, now), now);
        else if (this.inZone(t.last) && t.last.h_cm < HOVER_MAX_CM) this.emit(this.subs.move, hand, t.last, now);
        continue;
      }
      // No joints this frame: hold the gesture at the last good point for the grace time.
      t.visible = false;
      t.raw = null;
      t.fx.reset();
      t.fy.reset();
      t.fz.reset();
      if (!t.active) continue;
      t.lostAt ??= now;
      if (now - t.lostAt > this.graceMs) this.lose(t, hand, now);
    }
  }

  private select(hand: Side, phase: SelectPhase, now: number): void {
    const t = this.hands[hand];
    if (phase === 'start') {
      if (t.active || !t.visible || !t.raw) return;
      // Start where the hand is now: the filter may still be catching up with a fast
      // arrival, and a pinch on a card's edge must not land in its middle. Smoothing goes
      // on from this point.
      const p = this.project(t.raw);
      if (!this.inZone(p)) return;
      t.fx.reset();
      t.fy.reset();
      t.fz.reset();
      t.fx.filter(t.raw.x, now);
      t.fy.filter(t.raw.y, now);
      t.fz.filter(t.raw.z, now);
      t.last = p;
      t.active = true;
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
    for (const s of t.sent) if (s.t <= now - RELEASE_TRIM_MS) at = s.p;
    at ??= t.sent[0]?.p ?? t.last ?? t.downPoint;
    if (at) this.emit(this.subs.up, hand, at, now);
  }

  /** A gesture point with the pinch's closing drift held, then taken off. */
  private gesturePoint(t: HandTrack, p: Projected, now: number): Projected {
    const d = t.downPoint ?? p;
    let out: Projected;
    if (now - t.downAt < PINCH_SETTLE_MS) {
      out = { ...p, x_cm: d.x_cm, y_cm: d.y_cm };
    } else {
      if (!t.drift) {
        const dx = p.x_cm - d.x_cm;
        const dy = p.y_cm - d.y_cm;
        // A bigger move this early is the hand setting off, not drift.
        t.drift = Math.hypot(dx, dy) < PINCH_DRIFT_MAX_CM ? { x: dx, y: dy } : { x: 0, y: 0 };
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
