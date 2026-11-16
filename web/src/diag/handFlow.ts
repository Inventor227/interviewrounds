// The hands part of the device check, run on the desk sheet in passthrough: hold a pinch still, draw a 10 cm line,
// tap five targets, then pinch Done. Fed with the board's pointer (web/src/board/hand.ts: filtered gesture
// points in board cm) plus the raw pinch point of the same hand each frame, so the filter's effect shows in the
// numbers. A held controller does the same steps with its trigger (its tip on the sheet, or its ray from a
// distance); a line drawn that way is the controller draw test, kept next to the pinch one. Each stage has a Skip
// box. Pure logic: the scene (xrTest.ts) draws it and feeds it.

import { hitStats, jitter, straightness, type HitStats, type Jitter, type P2, type Straightness, type Tap } from './stats';

export type HandStage = 'hold' | 'line' | 'targets' | 'done';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Board cm: origin at the far left corner of the 64 x 40 cm sheet, y toward the user. */
export const HOLD_AT: P2 = { x: 32, y: 22 };
export const HOLD_MS = 3000;
/** The start of a pinch is left out of the hold numbers (the fingers are still closing). */
export const HOLD_SETTLE_MS = 300;
/** A hold must start this close to the dot. */
export const HOLD_START_CM = 4;
export const LINE_FROM: P2 = { x: 27, y: 22 };
export const LINE_TO: P2 = { x: 37, y: 22 };
export const LINE_MIN_CM = 5;
export const TARGETS: readonly P2[] = [
  { x: 14, y: 12 },
  { x: 50, y: 12 },
  { x: 32, y: 21 },
  { x: 14, y: 30 },
  { x: 50, y: 30 },
];
/** Hit radius of a target (cm); the board's small controls are 2.4 cm. */
export const TARGET_R = 2;
export const SKIP_BOX: Box = { x: 55, y: 33, w: 8, h: 6 };
export const DONE_BOX: Box = { x: 22, y: 16, w: 20, h: 10 };

export const inBox = (p: P2, b: Box, margin = 0) => p.x >= b.x - margin && p.x <= b.x + b.w + margin && p.y >= b.y - margin && p.y <= b.y + b.h + margin;
const dist = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);

export interface HandResults {
  hold: { filtered: Jitter | null; raw: Jitter | null; tries: number; skipped: boolean };
  line: { filtered: Straightness | null; raw: Straightness | null; tries: number; skipped: boolean };
  /** Taps with how long each pinch was held (a ghost card is dismissed by a 1 s hold). */
  targets: { stats: HitStats | null; taps: { target: P2; down: P2; up: P2; ms: number }[]; radius_cm: number; skipped: boolean };
  /** The draw test done with a controller (the trigger held): how straight the line was, and whether by touch or by ray. */
  controller_line: { filtered: Straightness | null; mode: 'touch' | 'ray' | null; tries: number };
  /** What did each stage: a hand's pinch or a controller's trigger. */
  by: { hold: Pointing | null; line: Pointing | null; targets: Pointing | null };
  /** Pinches the board saw start on the sheet, and the ones lost to tracking. */
  gestures: number;
  lost: number;
}

/** What made a gesture. */
export type Pointing = 'hand' | 'controller';
export type FlowInput = 'hands' | 'controllers';

/** The line under the sheet's title, worded for the input in use. */
export const FLOW_MESSAGES: Record<FlowInput, Record<HandStage, string>> = {
  hands: {
    hold: 'Pinch on the dot and hold still for 3 seconds.',
    line: 'Pinch the left dot, draw a straight line to the right dot, let go.',
    targets: 'Tap each ring as it lights up: a quick pinch on its centre.',
    done: 'All done. Pinch Done to go back to the page.',
  },
  controllers: {
    hold: 'Point at the dot, pull the trigger and hold still for 3 seconds.',
    line: 'Pull the trigger on the left dot, draw a straight line to the right dot, let go.',
    targets: 'Point at each ring as it lights up and pull the trigger.',
    done: 'All done. Pull the trigger on Done to go back to the page.',
  },
};

type Gesture = { kind: 'skip' | 'hold' | 'line' | 'tap' | 'done' | 'ignored'; start: number; down: P2; consumed: boolean; by: Pointing; ray: boolean };

export class HandFlow {
  stage: HandStage = 'hold';
  message = 'Pinch on the dot and hold still for 3 seconds.';
  /** Goes up whenever the drawing should change. */
  version = 0;
  target = 0;
  private g: Gesture | null = null;
  private filtered: P2[] = [];
  private raws: P2[] = [];
  private readonly res: HandResults = {
    hold: { filtered: null, raw: null, tries: 0, skipped: false },
    line: { filtered: null, raw: null, tries: 0, skipped: false },
    targets: { stats: null, taps: [], radius_cm: TARGET_R, skipped: false },
    controller_line: { filtered: null, mode: null, tries: 0 },
    by: { hold: null, line: null, targets: null },
    gestures: 0,
    lost: 0,
  };
  private input: FlowInput = 'hands';

  constructor(private readonly onExit: () => void = () => {}) {}

  /** The input in use changed (controllers picked up or put down): the instructions follow. */
  setInput(input: FlowInput): void {
    if (input === this.input) return;
    this.input = input;
    this.say(FLOW_MESSAGES[input][this.stage]);
  }

  results(): HandResults {
    return structuredClone(this.res);
  }

  /** The stroke so far in the line stage (for drawing). */
  stroke(): readonly P2[] {
    return this.stage === 'line' && this.g?.kind === 'line' ? this.filtered : [];
  }

  /** 0..1 while a hold runs. */
  holdProgress(now: number): number {
    if (this.g?.kind !== 'hold' || this.g.consumed) return 0;
    return Math.max(0, Math.min(1, (now - this.g.start - HOLD_SETTLE_MS) / HOLD_MS));
  }

  private say(msg: string): void {
    this.message = msg;
    this.version++;
  }

  /** `by`: what pressed (default a hand); `ray`: a controller pointing from a distance, not touching. */
  down(p: P2, t: number, by: Pointing = 'hand', ray = false): void {
    this.res.gestures++;
    let kind: Gesture['kind'];
    if (this.stage !== 'done' && inBox(p, SKIP_BOX, 1)) kind = 'skip';
    else if (this.stage === 'hold') kind = dist(p, HOLD_AT) <= HOLD_START_CM ? 'hold' : 'ignored';
    else if (this.stage === 'line') kind = 'line';
    else if (this.stage === 'targets') kind = 'tap';
    else kind = inBox(p, DONE_BOX, 1) ? 'done' : 'ignored';
    this.g = { kind, start: t, down: p, consumed: false, by, ray };
    this.filtered = kind === 'line' ? [p] : [];
    this.raws = [];
    if (kind === 'ignored' && this.stage === 'hold') this.say(by === 'hand' ? 'Start the pinch on the dot.' : 'Pull the trigger on the dot.');
    this.version++;
  }

  move(p: P2, t: number): void {
    const g = this.g;
    if (!g || g.consumed) return;
    if (g.kind === 'hold' && t - g.start >= HOLD_SETTLE_MS) this.filtered.push(p);
    else if (g.kind === 'line') {
      this.filtered.push(p);
      this.version++;
    }
  }

  /** The raw (unfiltered) pinch point of the gesture's hand this frame. */
  raw(p: P2 | null, t: number): void {
    const g = this.g;
    if (!g || g.consumed || !p) return;
    if ((g.kind === 'hold' && t - g.start >= HOLD_SETTLE_MS) || g.kind === 'line') this.raws.push(p);
  }

  /** Time passes: a hold completes on its own after 3 s. */
  tick(t: number): void {
    const g = this.g;
    if (g?.kind !== 'hold' || g.consumed) return;
    if (t - g.start < HOLD_SETTLE_MS + HOLD_MS) return;
    g.consumed = true;
    this.res.hold.tries++;
    this.res.hold.filtered = jitter(this.filtered);
    this.res.hold.raw = jitter(this.raws);
    this.res.by.hold = g.by;
    this.next('line');
  }

  up(p: P2, t: number): void {
    const g = this.g;
    this.g = null;
    if (!g || g.consumed) return;
    if (g.kind === 'skip') {
      if (inBox(p, SKIP_BOX, 1)) this.skip();
      return;
    }
    if (g.kind === 'hold') {
      this.res.hold.tries++;
      this.say(g.by === 'hand' ? 'You let go too early. Pinch the dot and hold for 3 seconds.' : 'You let go too early. Hold the trigger on the dot for 3 seconds.');
      return;
    }
    if (g.kind === 'line') {
      const mine = g.by === 'controller' ? this.res.controller_line : this.res.line;
      mine.tries++;
      const s = straightness(this.filtered, LINE_FROM, LINE_TO);
      if (!s || s.path_cm < LINE_MIN_CM) {
        this.say(g.by === 'hand' ? 'Too short. Pinch the left dot, draw to the right dot, let go.' : 'Too short. Hold the trigger from the left dot to the right dot, then let go.');
        return;
      }
      // A controller's line is its own result, next to the pinch one; a controller has no raw pinch point.
      if (g.by === 'controller') {
        this.res.controller_line.filtered = s;
        this.res.controller_line.mode = g.ray ? 'ray' : 'touch';
      } else {
        this.res.line.filtered = s;
        this.res.line.raw = straightness(this.raws, LINE_FROM, LINE_TO);
      }
      this.res.by.line = g.by;
      this.next('targets');
      return;
    }
    if (g.kind === 'tap') {
      const target = TARGETS[this.target]!;
      this.res.targets.taps.push({ target, down: g.down, up: p, ms: Math.round(t - g.start) });
      this.res.by.targets = g.by;
      this.target++;
      if (this.target >= TARGETS.length) {
        this.res.targets.stats = hitStats(this.taps(), TARGET_R);
        this.next('done');
      } else this.version++;
      return;
    }
    if (g.kind === 'done' && inBox(p, DONE_BOX, 1)) this.onExit();
  }

  /** The gesture was lost (tracking gone past the grace, or the system cancelled the pinch). */
  cancel(): void {
    this.res.lost++;
    const g = this.g;
    this.g = null;
    if (!g || g.consumed || g.kind === 'ignored') return;
    if (g.kind === 'hold') this.res.hold.tries++;
    if (g.kind === 'line') (g.by === 'controller' ? this.res.controller_line : this.res.line).tries++;
    this.say(g.by === 'hand' ? 'Your hand was lost. Try again.' : 'The controller was lost. Try again.');
  }

  private taps(): Tap[] {
    return this.res.targets.taps.map((t) => ({ target: t.target, at: t.up }));
  }

  private skip(): void {
    if (this.stage === 'hold') {
      this.res.hold.skipped = true;
      this.next('line');
    } else if (this.stage === 'line') {
      this.res.line.skipped = true;
      this.next('targets');
    } else if (this.stage === 'targets') {
      this.res.targets.skipped = true;
      this.res.targets.stats = hitStats(this.taps(), TARGET_R);
      this.next('done');
    }
  }

  private next(stage: HandStage): void {
    this.stage = stage;
    this.filtered = [];
    this.raws = [];
    this.say(FLOW_MESSAGES[this.input][stage]);
  }
}
