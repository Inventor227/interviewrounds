// Ink: smoothing and simplifying hand strokes so jitter never makes a mark.
import type { Pt } from './model';
import { MAX_INK_POINTS } from './validate';

/**
 * One Euro filter (Casiez et al. 2012) for one coordinate. Defaults are for metres and
 * seconds of a pinch point (research 06 §1.1): min cutoff 1 Hz, beta 10, derivative
 * cutoff 1 Hz. For board centimetres divide beta by 100.
 */
export class OneEuroFilter {
  private x: number | null = null;
  private lastRaw = 0;
  private dx = 0;
  private tMs = 0;

  constructor(
    readonly minCutoff = 1.0,
    readonly beta = 10,
    readonly dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, tMs: number): number {
    if (this.x === null) {
      this.x = x;
      this.lastRaw = x;
      this.tMs = tMs;
      return x;
    }
    // A repeated or backwards timestamp: assume one 72 Hz frame.
    const dt = tMs > this.tMs ? (tMs - this.tMs) / 1000 : 1 / 72;
    this.tMs = Math.max(tMs, this.tMs);
    // Speed from the raw samples, as in the reference implementation.
    const rawDx = (x - this.lastRaw) / dt;
    this.lastRaw = x;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }

  reset(): void {
    this.x = null;
    this.dx = 0;
  }
}

export function pathLength(points: readonly Pt[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return len;
}

/** Points every `step` cm along the stroke (first and last kept). */
export function resample(points: readonly Pt[], step = 0.4): Pt[] {
  if (points.length < 2) return points.map((p) => [p[0], p[1]]);
  const out: Pt[] = [[points[0]![0], points[0]![1]]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    let [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    let seg = Math.hypot(bx - ax, by - ay);
    while (carry + seg >= step && seg > 0) {
      const t = (step - carry) / seg;
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      out.push([ax, ay]);
      seg = Math.hypot(bx - ax, by - ay);
      carry = 0;
    }
    carry += seg;
  }
  const last = points[points.length - 1]!;
  const tail = out[out.length - 1]!;
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > 1e-6) out.push([last[0], last[1]]);
  return out;
}

/** Ramer-Douglas-Peucker: drops points within `epsCm` of the simplified line. */
export function simplify(points: readonly Pt[], epsCm = 0.3): Pt[] {
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a]!;
    const [bx, by] = points[b]!;
    const vx = bx - ax;
    const vy = by - ay;
    const len = Math.hypot(vx, vy);
    let best = -1;
    let bestD = epsCm;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]!;
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(vx * (ay - py) - vy * (ax - px)) / len;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push([points[i]![0], points[i]![1]]);
  return out;
}

/** Round to 1 decimal, the stored precision of ink points. */
export const round1 = (v: number): number => Math.round(v * 10) / 10;

/** How much of a hand stroke to drop at each end: the pinch closing hook and opening flick. */
export const PINCH_TRIM_MS = 80;

/**
 * Collects one stroke. Hand strokes lose their first and last 80 ms (the fingers closing
 * and opening move the pinch point); mouse strokes are kept whole. With `filter`, points
 * also pass a One Euro filter (for raw input that was not filtered upstream).
 */
export class StrokeBuilder {
  private raw: { x: number; y: number; t: number }[] = [];
  private fx: OneEuroFilter | null;
  private fy: OneEuroFilter | null;

  constructor(
    readonly hand: 'left' | 'right' | 'mouse',
    opts: { filter?: boolean } = {},
  ) {
    // Board cm: beta 10 per m/s is 0.1 per cm/s.
    this.fx = opts.filter ? new OneEuroFilter(1.0, 0.1, 1.0) : null;
    this.fy = opts.filter ? new OneEuroFilter(1.0, 0.1, 1.0) : null;
  }

  add(x: number, y: number, tMs: number): void {
    const px = this.fx ? this.fx.filter(x, tMs) : x;
    const py = this.fy ? this.fy.filter(y, tMs) : y;
    this.raw.push({ x: px, y: py, t: tMs });
  }

  get count(): number {
    return this.raw.length;
  }

  /** Every point so far, for live drawing. */
  live(): Pt[] {
    return this.raw.map((p) => [p.x, p.y]);
  }

  /** The finished stroke in board cm. */
  points(): Pt[] {
    let pts = this.raw;
    if (this.hand !== 'mouse' && pts.length > 2) {
      const t0 = pts[0]!.t + PINCH_TRIM_MS;
      const t1 = pts[pts.length - 1]!.t - PINCH_TRIM_MS;
      const trimmed = pts.filter((p) => p.t >= t0 && p.t <= t1);
      // A very quick stroke keeps its points rather than vanishing.
      if (trimmed.length >= 2) pts = trimmed;
    }
    return pts.map((p) => [p.x, p.y]);
  }

  /**
   * Simplified and rounded, ready for an ink item: at least 2 points, and at most
   * MAX_INK_POINTS (a very long scribble is simplified harder until it fits).
   */
  inkPoints(epsCm = 0.15, maxPoints = MAX_INK_POINTS): Pt[] {
    const raw = this.points();
    let eps = epsCm;
    let simple = simplify(raw, eps);
    while (simple.length > maxPoints) {
      eps *= 2;
      simple = simplify(raw, eps);
    }
    const pts = simple.map(([x, y]) => [round1(x), round1(y)] as Pt);
    const dedup: Pt[] = [];
    for (const p of pts) {
      const last = dedup[dedup.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) dedup.push(p);
    }
    if (dedup.length === 1) dedup.push([dedup[0]![0], dedup[0]![1]]);
    return dedup;
  }
}
