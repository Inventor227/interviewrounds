// Session-scoped state for the room: the desk placement promise and the anchor that keeps the room on the desk.
// Pure (no WebGL) so the re-enter and mid-placement exit paths are testable.
//
// Placement is explicit: nothing starts until place() is called, and it belongs to one XR session. A session end
// rejects a pending place() with PlacementCancelled and forgets the desk; a new session starts clean.

import type { DeskPose } from './placement';

export class PlacementCancelled extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PlacementCancelled';
  }
}

export interface PlacementHooks {
  /** Begin a placement (show the prompt, ghost sheet and ring). */
  start(): void;
  /** Drop session state: hide the room, clear the desk, stop the placement visuals. */
  reset(): void;
}

export class PlacementLifecycle {
  desk: DeskPose | null = null;
  private inSession = false;
  private pending: { promise: Promise<DeskPose>; resolve: (d: DeskPose) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly hooks: PlacementHooks) {}

  get placing(): boolean {
    return this.pending !== null;
  }

  sessionStarted(): void {
    this.cancel('A new session started');
    this.desk = null;
    this.inSession = true;
    this.hooks.reset();
  }

  sessionEnded(): void {
    this.inSession = false;
    this.cancel('The session ended before the desk was placed');
    this.desk = null;
    this.hooks.reset();
  }

  /** The desk for this session: the one already placed, the placement under way, or a new placement. */
  place(): Promise<DeskPose> {
    if (!this.inSession) return Promise.reject(new PlacementCancelled('No immersive session'));
    if (this.desk) return Promise.resolve(this.desk);
    if (this.pending) return this.pending.promise;
    return this.begin();
  }

  /** Places the desk again in the same session (e.g. "Move sheet"). */
  replace(): Promise<DeskPose> {
    if (!this.inSession) return Promise.reject(new PlacementCancelled('No immersive session'));
    if (this.pending) return this.pending.promise;
    this.desk = null;
    return this.begin();
  }

  /** The placement finished (touch or fallback). Ignored when nothing is pending (a late result). */
  finished(desk: DeskPose): void {
    const p = this.pending;
    if (!p || !this.inSession) return;
    this.pending = null;
    this.desk = desk;
    p.resolve(desk);
  }

  private begin(): Promise<DeskPose> {
    let resolve!: (d: DeskPose) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<DeskPose>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending = { promise, resolve, reject };
    this.hooks.start();
    return promise;
  }

  private cancel(reason: string): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(new PlacementCancelled(reason));
  }
}

/** The bits of XRAnchor we use. */
export interface AnchorLike {
  anchorSpace: XRSpace;
  delete?(): void;
}

/**
 * Keeps the room on its anchor. Each placement takes a generation number; an anchor that resolves after a newer
 * placement began is deleted at once. A pose read that throws (an anchor of an ended session) drops the anchor
 * instead of failing every frame.
 */
export class AnchorTracker {
  private gen = 0;
  private cur: { anchor: AnchorLike; inv: Float32Array } | null = null;
  private readonly out = new Float32Array(16);

  constructor(private readonly apply: (m: Float32Array) => void) {}

  get active(): boolean {
    return this.cur !== null;
  }

  /** A new placement: forget (and delete) the current anchor; returns the generation for adopt(). */
  begin(): number {
    this.clear();
    return ++this.gen;
  }

  /** The anchor created for generation `gen`, with the inverse of the pose it was created at. */
  adopt(gen: number, anchor: AnchorLike, inverseOfCreatePose: Float32Array): void {
    if (gen !== this.gen) {
      safeDelete(anchor);
      return;
    }
    this.clear();
    this.cur = { anchor, inv: Float32Array.from(inverseOfCreatePose) };
  }

  update(frame: XRFrame, ref: XRReferenceSpace): void {
    if (!this.cur) return;
    let m: Float32Array | undefined;
    try {
      m = frame.getPose(this.cur.anchor.anchorSpace, ref)?.transform.matrix;
    } catch {
      this.clear();
      return;
    }
    if (!m) return;
    multiply(this.out, m, this.cur.inv);
    this.apply(this.out);
  }

  clear(): void {
    if (this.cur) safeDelete(this.cur.anchor);
    this.cur = null;
  }

  /** Session over: drop the anchor and invalidate any createAnchor still in flight. */
  reset(): void {
    this.clear();
    this.gen++;
  }
}

function safeDelete(a: AnchorLike): void {
  try {
    a.delete?.();
  } catch {
    // Already gone with its session.
  }
}

/** out = a * b (column-major 4x4). */
function multiply(out: Float32Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
}
