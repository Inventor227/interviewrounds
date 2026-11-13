// Numbers for the device check (/diag): frame times, pinch jitter, line straightness, tap hits, pinch counts and
// levels. Pure functions, no browser APIs. Distances are board centimetres (web/src/board), times milliseconds.

export interface P2 {
  x: number;
  y: number;
}

const round = (v: number, d = 2) => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

/** Linear interpolated percentile (p in 0..100) of unsorted values; NaN when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export interface FrameStats {
  frames: number;
  seconds: number;
  /** Frames per second over the window. */
  fps: number;
  /** The nominal frame period the late count used. */
  period_ms: number;
  p50_ms: number;
  p90_ms: number;
  p99_ms: number;
  max_ms: number;
  /** Share of frames whose interval exceeded lateFactor periods (a missed vsync), in percent. */
  late_pct: number;
}

/** Stats of frame intervals (ms) against a nominal period. Null without intervals. */
export function frameStats(intervalsMs: readonly number[], periodMs: number, lateFactor = 1.5): FrameStats | null {
  const xs = intervalsMs.filter((v) => Number.isFinite(v) && v > 0);
  if (xs.length === 0) return null;
  const total = xs.reduce((a, b) => a + b, 0);
  const late = xs.filter((v) => v > lateFactor * periodMs).length;
  return {
    frames: xs.length,
    seconds: round(total / 1000, 1),
    fps: round((xs.length * 1000) / total, 1),
    period_ms: round(periodMs),
    p50_ms: round(percentile(xs, 50)),
    p90_ms: round(percentile(xs, 90)),
    p99_ms: round(percentile(xs, 99)),
    max_ms: round(Math.max(...xs)),
    late_pct: round((late / xs.length) * 100),
  };
}

export interface Jitter {
  n: number;
  /** Root mean square distance from the mean point. */
  rms_cm: number;
  max_cm: number;
}

/** How much a point held still wanders: RMS and max distance from its mean. */
export function jitter(points: readonly P2[]): Jitter | null {
  if (points.length < 2) return null;
  const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
  let sq = 0;
  let max = 0;
  for (const p of points) {
    const d = Math.hypot(p.x - cx, p.y - cy);
    sq += d * d;
    max = Math.max(max, d);
  }
  return { n: points.length, rms_cm: round(Math.sqrt(sq / points.length), 3), max_cm: round(max, 3) };
}

export interface Straightness {
  n: number;
  /** Start to end distance. */
  length_cm: number;
  /** Length along the stroke. */
  path_cm: number;
  /** Distance of the points from their best fit line (total least squares): RMS and max. */
  rms_cm: number;
  max_cm: number;
  /** Angle of the fitted line against the target line (degrees, 0 = parallel). */
  angle_deg: number | null;
  /** Distance of the first and last point from the target ends. */
  start_err_cm: number | null;
  end_err_cm: number | null;
}

/** How straight a drawn line is, and how well it hits the target ends when given. */
export function straightness(points: readonly P2[], from?: P2, to?: P2): Straightness | null {
  if (points.length < 2) return null;
  const n = points.length;
  const cx = points.reduce((a, p) => a + p.x, 0) / n;
  const cy = points.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Principal direction of the point cloud.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  let sq = 0;
  let max = 0;
  for (const p of points) {
    const d = Math.abs(-(p.x - cx) * uy + (p.y - cy) * ux);
    sq += d * d;
    max = Math.max(max, d);
  }
  let path = 0;
  for (let i = 1; i < n; i++) path += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  const first = points[0]!;
  const last = points[n - 1]!;
  let angle: number | null = null;
  if (from && to) {
    const tx = to.x - from.x;
    const ty = to.y - from.y;
    const cos = Math.abs(ux * tx + uy * ty) / Math.hypot(tx, ty);
    angle = round((Math.acos(Math.min(1, cos)) * 180) / Math.PI, 1);
  }
  return {
    n,
    length_cm: round(Math.hypot(last.x - first.x, last.y - first.y)),
    path_cm: round(path),
    rms_cm: round(Math.sqrt(sq / n), 3),
    max_cm: round(max, 3),
    angle_deg: angle,
    start_err_cm: from ? round(Math.hypot(first.x - from.x, first.y - from.y)) : null,
    end_err_cm: to ? round(Math.hypot(last.x - to.x, last.y - to.y)) : null,
  };
}

export interface Tap {
  target: P2;
  at: P2;
}

export interface HitStats {
  taps: number;
  hits: number;
  /** Hits per tap, 0..1. */
  rate: number;
  /** Mean offset of the taps from their targets (systematic bias). */
  mean_dx_cm: number;
  mean_dy_cm: number;
  mean_dist_cm: number;
  max_dist_cm: number;
}

/** Hit rate and offsets of taps on targets of the given radius. */
export function hitStats(taps: readonly Tap[], radiusCm: number): HitStats | null {
  if (taps.length === 0) return null;
  let hits = 0;
  let dx = 0;
  let dy = 0;
  let dist = 0;
  let max = 0;
  for (const t of taps) {
    const ox = t.at.x - t.target.x;
    const oy = t.at.y - t.target.y;
    const d = Math.hypot(ox, oy);
    if (d <= radiusCm) hits++;
    dx += ox;
    dy += oy;
    dist += d;
    max = Math.max(max, d);
  }
  const n = taps.length;
  return {
    taps: n,
    hits,
    rate: round(hits / n, 3),
    mean_dx_cm: round(dx / n),
    mean_dy_cm: round(dy / n),
    mean_dist_cm: round(dist / n),
    max_dist_cm: round(max),
  };
}

/**
 * Counts pinches from the fingers alone (thumb to index distance, as the 0..1 pinch value of web/src/xr), with
 * hysteresis, to compare against the system's select events.
 */
export class PinchCounter {
  count = 0;
  private closed = false;

  constructor(
    readonly closeAt = 0.85,
    readonly openAt = 0.4,
  ) {}

  /** One frame's pinch value, or null when the hand is not tracked. Returns true when a new pinch closed. */
  feed(pinch: number | null): boolean {
    if (pinch === null) {
      this.closed = false;
      return false;
    }
    if (!this.closed && pinch >= this.closeAt) {
      this.closed = true;
      this.count++;
      return true;
    }
    if (this.closed && pinch <= this.openAt) this.closed = false;
    return false;
  }
}

/** System selects per finger pinch (1 = every pinch made a select). Null without pinches. */
export function selectRatio(selects: number, pinches: number): number | null {
  return pinches > 0 ? round(selects / pinches, 3) : null;
}

/** RMS of samples in -1..1. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i]! * samples[i]!;
  return Math.sqrt(s / samples.length);
}

/** Level in dBFS, floored at -100. */
export function toDb(rmsValue: number): number {
  if (!(rmsValue > 0)) return -100;
  return Math.max(-100, round(20 * Math.log10(rmsValue), 1));
}

export interface LevelSummary {
  n: number;
  /** A quiet level (20th percentile) and a loud one (95th), dBFS. */
  p20_db: number;
  p50_db: number;
  p95_db: number;
  max_db: number;
}

export function levelSummary(dbs: readonly number[]): LevelSummary | null {
  if (dbs.length === 0) return null;
  return {
    n: dbs.length,
    p20_db: round(percentile(dbs, 20), 1),
    p50_db: round(percentile(dbs, 50), 1),
    p95_db: round(percentile(dbs, 95), 1),
    max_db: round(Math.max(...dbs), 1),
  };
}
