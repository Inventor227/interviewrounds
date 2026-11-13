// Stroke recognition: deterministic geometry, no templates. A rough box becomes a
// component card, a line from one card to another becomes a connection, a circle
// becomes a client, anything else stays ink. Under 1.5 cm a stroke is jitter: no mark.
import type { Board, BoardItem } from '../shared/types';
import { pathLength, resample, simplify } from './ink';
import { inRect, itemRect, nearestNode, snap, type Pt } from './model';

export type Recognized =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'connector'; from: string; to: string; arrow: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ink' };

/** Strokes shorter than this make no mark. */
export const MIN_STROKE_CM = 1.5;
/** A connector may start or end this far outside a card. */
export const CONNECT_MARGIN_CM = 1.0;
/** Smallest card a box can become (either orientation). */
export const MIN_RECT = { long: 3, short: 2 } as const;

const STEP = 0.25;
/** Upper bound on resampled points, so a long or jagged stroke costs the same as a short one. */
const MAX_POINTS = 160;

/**
 * What a finished stroke (board cm) means on this board. Null when the stroke is too
 * short to keep. Fast: well under 2 ms for 200 points.
 */
export function recognize(stroke: readonly Pt[], board: Board): Recognized | null {
  if (stroke.length < 2) return null;
  const len = pathLength(stroke);
  if (len < MIN_STROKE_CM) return null;
  const step = Math.max(STEP, len / MAX_POINTS);
  const pts = resample(stroke, step);
  return connector(pts, len, board) ?? closedShape(pts, len, step) ?? { kind: 'ink' };
}

function nodeNear(board: Board, p: Pt, exclude?: string): BoardItem | null {
  const hit = nearestNode(board, p[0], p[1], CONNECT_MARGIN_CM, exclude);
  if (hit) return hit;
  // Regions (groups) only when the point is inside one and no card is near.
  for (let i = board.items.length - 1; i >= 0; i--) {
    const it = board.items[i]!;
    if (it.kind === 'group' && it.id !== exclude && inRect(itemRect(it), p[0], p[1])) return it;
  }
  return null;
}

function turnDeg(a: Pt, b: Pt, c: Pt): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const nu = Math.hypot(ux, uy);
  const nv = Math.hypot(vx, vy);
  if (nu === 0 || nv === 0) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * The arrow tip when the stroke ends in a hook (an arrowhead drawn in the same stroke):
 * the first sharp turn (over 100 degrees) in the last part of the stroke.
 */
function hookTip(pts: Pt[], len: number): Pt | null {
  const poly = simplify(pts, 0.35);
  if (poly.length < 3) return null;
  const tail = Math.max(4, 0.4 * len);
  // Arc length from each vertex to the end.
  const rest: number[] = new Array(poly.length).fill(0);
  for (let i = poly.length - 2; i >= 0; i--) rest[i] = rest[i + 1]! + Math.hypot(poly[i + 1]![0] - poly[i]![0], poly[i + 1]![1] - poly[i]![1]);
  for (let k = 1; k < poly.length - 1; k++) {
    if (rest[k]! > tail || rest[k]! < 0.6) continue;
    if (turnDeg(poly[k - 1]!, poly[k]!, poly[k + 1]!) > 100) return poly[k]!;
  }
  return null;
}

function connector(pts: Pt[], len: number, board: Board): Recognized | null {
  const from = nodeNear(board, pts[0]!);
  if (!from) return null;
  const tip = hookTip(pts, len);
  const end = tip ?? pts[pts.length - 1]!;
  const to = nodeNear(board, end, from.id);
  if (!to) return null;
  return { kind: 'connector', from: from.id, to: to.id, arrow: tip !== null };
}

/** Index where a stroke closes on its start, or -1 when it stays open. */
function closeIndex(pts: Pt[], len: number): number {
  const [sx, sy] = pts[0]!;
  const near = Math.max(1.5, 0.15 * len);
  const from = Math.floor(pts.length * 0.6);
  let best = -1;
  let bestD = Infinity;
  for (let i = from; i < pts.length; i++) {
    const d = Math.hypot(pts[i]![0] - sx, pts[i]![1] - sy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return bestD <= near ? best : -1;
}

/** Circular moving average, to calm per-point tracking noise before fitting. */
function smoothLoop(pts: Pt[], half = 3): Pt[] {
  const n = pts.length;
  if (n < 2 * half + 1) return pts;
  return pts.map((_, i) => {
    let x = 0;
    let y = 0;
    for (let k = -half; k <= half; k++) {
      const p = pts[(i + k + n) % n]!;
      x += p[0];
      y += p[1];
    }
    return [x / (2 * half + 1), y / (2 * half + 1)] as Pt;
  });
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface RectFit {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  resid: number;
  covered: boolean;
}

/** Axis-aligned box fit: each point votes for its nearest side; sides move to the median. */
function fitRect(loop: Pt[]): RectFit {
  const xs = loop.map((p) => p[0]).sort((a, b) => a - b);
  const ys = loop.map((p) => p[1]).sort((a, b) => a - b);
  const q = (s: number[], f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]!;
  let x0 = q(xs, 0.03);
  let x1 = q(xs, 0.97);
  let y0 = q(ys, 0.03);
  let y1 = q(ys, 0.97);
  let side: number[] = [];
  for (let iter = 0; iter < 3; iter++) {
    const L: number[] = [];
    const R: number[] = [];
    const T: number[] = [];
    const B: number[] = [];
    side = loop.map(([x, y]) => {
      const d = [Math.abs(x - x0), Math.abs(x - x1), Math.abs(y - y0), Math.abs(y - y1)];
      let k = 0;
      for (let j = 1; j < 4; j++) if (d[j]! < d[k]!) k = j;
      [L, R, T, B][k]!.push(k < 2 ? x : y);
      return k;
    });
    if (L.length) x0 = median(L);
    if (R.length) x1 = median(R);
    if (T.length) y0 = median(T);
    if (B.length) y1 = median(B);
  }
  // Distance from each point to the box outline.
  let sum = 0;
  for (const [x, y] of loop) {
    const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const d = inside
      ? Math.min(x - x0, x1 - x, y - y0, y1 - y)
      : Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
    sum += d;
  }
  // Every side must be drawn along most of its length (that is what makes 4 corners).
  const span = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  loop.forEach(([x, y], i) => {
    const k = side[i]!;
    const v = k < 2 ? y : x;
    span[2 * k] = Math.min(span[2 * k]!, v);
    span[2 * k + 1] = Math.max(span[2 * k + 1]!, v);
  });
  const w = x1 - x0;
  const h = y1 - y0;
  const cover = (k: number, full: number) => (span[2 * k + 1]! - span[2 * k]!) / Math.max(full, 1e-6);
  const covered = w > 0 && h > 0 && cover(0, h) > 0.55 && cover(1, h) > 0.55 && cover(2, w) > 0.55 && cover(3, w) > 0.55;
  return { x0, y0, x1, y1, resid: sum / loop.length, covered };
}

interface EllipseFit {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  resid: number;
}

/** Axis-aligned ellipse fit from evenly spaced points. */
function fitEllipse(loop: Pt[]): EllipseFit {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of loop) {
    cx += x;
    cy += y;
  }
  cx /= loop.length;
  cy /= loop.length;
  let ax = 0;
  let ay = 0;
  for (const [x, y] of loop) {
    ax += Math.abs(x - cx);
    ay += Math.abs(y - cy);
  }
  // Mean |cos| over a full turn is 2 / pi.
  const rx = Math.max(1e-6, ((ax / loop.length) * Math.PI) / 2);
  const ry = Math.max(1e-6, ((ay / loop.length) * Math.PI) / 2);
  const r = (rx + ry) / 2;
  let sum = 0;
  for (const [x, y] of loop) sum += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * r;
  return { cx, cy, rx, ry, resid: sum / loop.length };
}

/** Largest turn along the loop over an arc of `arm` cm each side. */
function maxTurn(loop: Pt[], arm: number, step: number): number {
  const n = loop.length;
  const k = Math.max(1, Math.round(arm / step));
  if (n < 2 * k + 1) return 0;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const t = turnDeg(loop[(i - k + n) % n]!, loop[i]!, loop[(i + k) % n]!);
    if (t > best) best = t;
  }
  return best;
}

function closedShape(pts: Pt[], len: number, step: number): Recognized | null {
  const cut = closeIndex(pts, len);
  if (cut < 0) return null;
  // Average over about 1.5 cm of stroke.
  const loop = smoothLoop(pts.slice(0, cut + 1), Math.max(1, Math.round(0.75 / step)));
  if (loop.length < 12) return null;
  const rect = fitRect(loop);
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  if (w < 1 || h < 1) return null;
  const scale = (w + h) / 4;
  const ell = fitEllipse(loop);
  const rectScore = rect.resid / scale;
  const ellScore = ell.resid / scale;

  if (rect.covered && rectScore < ellScore && rectScore < 0.22) {
    const x = snap(rect.x0);
    const y = snap(rect.y0);
    const sw = snap(rect.x1) - x;
    const sh = snap(rect.y1) - y;
    if (Math.max(sw, sh) < MIN_RECT.long || Math.min(sw, sh) < MIN_RECT.short) return null;
    return { kind: 'rect', x, y, w: sw, h: sh };
  }
  const aspect = ell.rx / ell.ry;
  if (ellScore < rectScore && ellScore < 0.15 && aspect > 0.55 && aspect < 1.8 && maxTurn(loop, 0.25 * scale, step) < 65) {
    const r = (ell.rx + ell.ry) / 2;
    if (2 * r < MIN_RECT.short) return null;
    return { kind: 'circle', cx: ell.cx, cy: ell.cy, r };
  }
  return null;
}
