// Helpers shared by the board tests: a seeded random source, hand-like strokes and a
// pointer adapter the tests drive directly. Not used by the app.
import type { BoardPoint, PointerAdapter } from './input';

export type Pt = [number, number];

/** Small deterministic PRNG (mulberry32), so wobbly strokes are the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points every `step` cm along a polyline. */
export function along(corners: Pt[], step = 0.25): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i]!;
    const [bx, by] = corners[i + 1]!;
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(corners[corners.length - 1]!);
  return out;
}

/**
 * Hand-drawn wobble: a slow drift plus a little per-point noise, never more than
 * `amp` cm from the clean path in x or y.
 */
export function wobble(points: Pt[], amp: number, seed: number): Pt[] {
  const r = rng(seed);
  const p1 = r() * 6.28;
  const p2 = r() * 6.28;
  return points.map(([x, y], i) => {
    const slow = 0.6 * amp;
    const fast = 0.4 * amp;
    const dx = slow * Math.sin(i * 0.11 + p1) + fast * (r() * 2 - 1);
    const dy = slow * Math.sin(i * 0.13 + p2) + fast * (r() * 2 - 1);
    return [x + dx, y + dy];
  });
}

/** Uniform independent noise in [-amp, amp] on every point (the worst case for a fit). */
export function jitter(points: Pt[], amp: number, seed: number): Pt[] {
  const r = rng(seed);
  return points.map(([x, y]) => [x + amp * (r() * 2 - 1), y + amp * (r() * 2 - 1)]);
}

/** A rough box from (x, y) to (x + w, y + h), started mid top edge and closed with a small overshoot. */
export function roughBox(x: number, y: number, w: number, h: number, amp: number, seed: number, noise: 'wobble' | 'jitter' = 'wobble'): Pt[] {
  const sx = x + w * 0.3;
  const path = along([
    [sx, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
    [sx + 0.8, y],
  ]);
  return noise === 'wobble' ? wobble(path, amp, seed) : jitter(path, amp, seed);
}

export function roughCircle(cx: number, cy: number, r: number, amp: number, seed: number): Pt[] {
  const pts: Pt[] = [];
  const n = Math.round((2 * Math.PI * r) / 0.25);
  for (let i = 0; i <= n + 3; i++) {
    const a = -Math.PI / 2 + (i / n) * 2 * Math.PI;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return wobble(pts, amp, seed);
}

/** A pointer adapter the tests drive by hand. */
export class FakeAdapter implements PointerAdapter {
  private downs: ((p: BoardPoint) => void)[] = [];
  private moves: ((p: BoardPoint) => void)[] = [];
  private ups: ((p: BoardPoint) => void)[] = [];
  private t = 0;

  onDown(cb: (p: BoardPoint) => void): () => void {
    this.downs.push(cb);
    return () => (this.downs = this.downs.filter((c) => c !== cb));
  }
  onMove(cb: (p: BoardPoint) => void): () => void {
    this.moves.push(cb);
    return () => (this.moves = this.moves.filter((c) => c !== cb));
  }
  onUp(cb: (p: BoardPoint) => void): () => void {
    this.ups.push(cb);
    return () => (this.ups = this.ups.filter((c) => c !== cb));
  }

  private pt(x: number, y: number, hand: BoardPoint['hand']): BoardPoint {
    this.t += 14;
    return { x_cm: x, y_cm: y, t_ms: this.t, hand };
  }
  down(x: number, y: number, hand: BoardPoint['hand'] = 'mouse'): void {
    const p = this.pt(x, y, hand);
    this.downs.forEach((c) => c(p));
  }
  move(x: number, y: number, hand: BoardPoint['hand'] = 'mouse'): void {
    const p = this.pt(x, y, hand);
    this.moves.forEach((c) => c(p));
  }
  up(x: number, y: number, hand: BoardPoint['hand'] = 'mouse'): void {
    const p = this.pt(x, y, hand);
    this.ups.forEach((c) => c(p));
  }
  /** Lets time pass with the pointer held still (a pinch-hold). */
  wait(ms: number): void {
    this.t += ms;
  }
  cancel(x: number, y: number, hand: BoardPoint['hand'] = 'mouse'): void {
    const p = this.pt(x, y, hand);
    this.cancels.forEach((c) => c(p));
  }
  private cancels: ((p: BoardPoint) => void)[] = [];
  onCancel(cb: (p: BoardPoint) => void): () => void {
    this.cancels.push(cb);
    return () => (this.cancels = this.cancels.filter((c) => c !== cb));
  }
  /** down at the first point, move through the rest, up at the last. */
  stroke(points: Pt[], hand: BoardPoint['hand'] = 'mouse'): void {
    const [first, ...rest] = points;
    if (!first) return;
    this.down(first[0], first[1], hand);
    for (const [x, y] of rest) this.move(x, y, hand);
    const last = points[points.length - 1]!;
    this.up(last[0], last[1], hand);
  }
}
