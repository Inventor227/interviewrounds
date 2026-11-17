// Replays of real hand input through the whole board path (XR samples → HandAdapter → BoardInput → ops): fingertips
// that jitter a few millimetres each, a slow tremor, uneven frames, poses repeated or missing for a frame, the pinch
// point sliding as the fingers close, a pinch that lets go for a moment mid stroke, and tracking that drops out.
import { describe, expect, it } from 'vitest';
import type { BoardOp } from '../shared/types';
import { HandAdapter } from './hand';
import { BoardInput } from './input';
import { HLD_KIT } from './kits';
import { emptyBoard, tabCenter, type Pt } from './model';
import { BoardStore } from './ops';
import { SheetProjector, sheetToWorld } from './sheetMath';
import { along, rng } from './testkit';
import { FakePort } from './xrtestkit';

interface Noise {
  /** Each fingertip on its own, uniform within ± this (mm). */
  tipMm: number;
  /** A slow wander of the whole hand (mm, about 3 to 9 Hz). */
  tremorMm: number;
  /** Frame times are drawn from this range (ms). */
  frameMs: [number, number];
  /** Chance a frame repeats the last pose (the runtime had no new one). */
  repeat: number;
  /** Chance a frame has no hand pose at all. */
  drop: number;
  /** How far the pinch point slides as the fingers finish closing after the pinch starts (cm). */
  closeCm: number;
}

const REAL: Noise = { tipMm: 2, tremorMm: 1.5, frameMs: [11, 42], repeat: 0.1, drop: 0.03, closeCm: 1 };

interface Events {
  /** The system pinch lets go at this fraction of the path for `ms`, then picks up again. */
  release?: { at: number; ms: number }[];
  /** No hand pose at this fraction of the path for `ms` (the pinch is still held). */
  loss?: { at: number; ms: number }[];
}

/** One hand drawing `path` (board cm) at `speed` cm/s with real noise, from settle to lift. */
function replay(port: FakePort, path: Pt[], seed: number, noise: Noise = REAL, ev: Events = {}, speed = 18): void {
  const r = rng(seed);
  const hand = 'right' as const;
  const ph = [r() * 6.28, r() * 6.28, r() * 6.28];
  const fr = [3 + r() * 6, 3 + r() * 6, 3 + r() * 6];
  let tMs = 0;
  let last: { thumb: ReturnType<typeof sheetToWorld>; index: ReturnType<typeof sheetToWorld> } | null = null;
  const closeDir = r() * 6.28;
  let pinchAt: number | null = null;
  let offline = 0;
  /** One frame with the pinch point at board (x, y) plus the closing slide. */
  const frame = (x: number, y: number) => {
    const dt = noise.frameMs[0] + r() * (noise.frameMs[1] - noise.frameMs[0]);
    tMs += dt;
    const k = pinchAt === null ? 0 : Math.min(1, (tMs - pinchAt) / 100);
    const cx = x + Math.cos(closeDir) * noise.closeCm * k;
    const cy = y + Math.sin(closeDir) * noise.closeCm * k;
    if (offline > 0 || r() < noise.drop) {
      offline = Math.max(0, offline - dt);
      port.setHandTips(hand, null, null);
    } else if (last && r() < noise.repeat) {
      port.setHandTips(hand, last.thumb, last.index);
    } else {
      const s = tMs / 1000;
      const tr = (i: number) => (noise.tremorMm / 1000) * Math.sin(2 * Math.PI * fr[i]! * s + ph[i]!);
      const c = sheetToWorld(port.sheetAnchor, cx, cy, 0.8);
      const tip = () => (noise.tipMm / 1000) * (r() * 2 - 1);
      const thumb = { x: c.x - 0.005 + tr(0) + tip(), y: c.y + tr(1) + tip(), z: c.z + tr(2) + tip() };
      const index = { x: c.x + 0.005 + tr(0) + tip(), y: c.y + tr(1) + tip(), z: c.z + tr(2) + tip() };
      last = { thumb, index };
      port.setHandTips(hand, thumb, index);
    }
    port.frame(dt);
  };
  const hold = (x: number, y: number, ms: number) => {
    const end = tMs + ms;
    while (tMs < end) frame(x, y);
  };
  // Arrive and rest a moment over the first point, then pinch.
  const [x0, y0] = path[0]!;
  hold(x0, y0, 300);
  port.select(hand, 'start', 'hand');
  pinchAt = tMs;
  hold(x0, y0, 120);
  // Along the path at the hand's speed.
  const lens = [0];
  for (let i = 1; i < path.length; i++) lens.push(lens[i - 1]! + Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]));
  const total = lens[lens.length - 1]!;
  const t0 = tMs;
  const pending = [...(ev.release ?? []).map((e) => ({ ...e, kind: 'release' as const })), ...(ev.loss ?? []).map((e) => ({ ...e, kind: 'loss' as const }))].sort((a, b) => a.at - b.at);
  let resumeAt: number | null = null;
  for (;;) {
    const d = Math.min(total, ((tMs - t0) / 1000) * speed);
    let i = 1;
    while (i < lens.length - 1 && lens[i]! < d) i++;
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = lens[i]! - lens[i - 1]! || 1;
    const u = Math.max(0, Math.min(1, (d - lens[i - 1]!) / seg));
    const x = a[0] + (b[0] - a[0]) * u;
    const y = a[1] + (b[1] - a[1]) * u;
    if (resumeAt !== null && tMs >= resumeAt) {
      port.select(hand, 'start', 'hand');
      resumeAt = null;
    }
    const e = pending[0];
    if (e && d >= e.at * total) {
      pending.shift();
      if (e.kind === 'release') {
        port.select(hand, 'end', 'hand');
        resumeAt = tMs + e.ms;
      } else offline = e.ms;
    }
    frame(x, y);
    if (d >= total && resumeAt === null) break;
  }
  const [xn, yn] = path[path.length - 1]!;
  hold(xn, yn, 150);
  port.select(hand, 'end', 'hand');
  pinchAt = null;
  // The fingers open and the hand lifts away.
  hold(xn, yn, 250);
  port.setHandTips(hand, null, null);
  port.frame();
}

function setup(cards: { id: string; x: number; y: number; w: number; h: number }[] = []) {
  const port = new FakePort();
  const proj = new SheetProjector(port.sheetAnchor);
  const hands = new HandAdapter(port, (q) => proj.project(q), { zone: HLD_KIT.view });
  const store = new BoardStore(emptyBoard());
  for (const c of cards) store.apply({ op_id: `s-${c.id}`, src: 'hand', op: 'item.create', args: { kind: 'component', type: 'service', label: null, ...c } });
  const ops: BoardOp[] = [];
  new BoardInput(store, hands, HLD_KIT, (op) => {
    ops.push(op);
    store.apply(op, { local: true });
  });
  return { port, store, ops };
}

/** A box outline as a person draws it: from a corner region, round in one direction, a small overshoot to close. */
function boxPath(x: number, y: number, w: number, h: number, cw: boolean, slantDeg: number): Pt[] {
  const c: Pt[] = [
    [x + w * 0.25, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x, y],
    [x + w * 0.25 + 1, y],
  ];
  const pts = cw ? c : [c[0]!, c[4]!, c[3]!, c[2]!, c[1]!, [x + w * 0.25 - 1, y] as Pt];
  const cx = x + w / 2;
  const cy = y + h / 2;
  const a = (slantDeg * Math.PI) / 180;
  return along(pts.map(([px, py]) => [cx + (px - cx) * Math.cos(a) - (py - cy) * Math.sin(a), cy + (px - cx) * Math.sin(a) + (py - cy) * Math.cos(a)] as Pt), 0.5);
}

const created = (ops: BoardOp[]) => ops.filter((o) => o.op === 'item.create').map((o) => (o.args as { kind: string; type?: string }).kind === 'component' ? (o.args as { type: string }).type : (o.args as { kind: string }).kind);

describe('noisy hands: shapes drawn with a real pinch', () => {
  const sizes: [number, number][] = [
    [8, 5],
    [12, 7],
    [18, 10],
  ];
  const cases: [number, number, boolean, number, number][] = [];
  for (const [w, h] of sizes) for (const cw of [true, false]) for (const slant of [-6, 0, 6]) for (const seed of [1, 2, 3, 4]) cases.push([w, h, cw, slant, seed]);

  it(`a box becomes one card in at least 95% of ${cases.length} noisy strokes (sizes, both directions, slanted), and never a stray mark`, () => {
    const misses: string[] = [];
    for (const [w, h, cw, slant, seed] of cases) {
      const { port, ops } = setup();
      replay(port, boxPath(20, 12, w, h, cw, slant), seed);
      const made = created(ops);
      if (made.length !== 1 || made[0] !== 'service') misses.push(`${w}x${h} ${cw ? 'cw' : 'ccw'} ${slant}deg seed ${seed}: ${made.join(',') || 'nothing'}`);
      // Never two things from one stroke.
      expect(made.length, `${w}x${h} seed ${seed}`).toBeLessThanOrEqual(1);
    }
    expect(misses.length / cases.length, misses.join('\n')).toBeLessThanOrEqual(0.05);
  });

  it('a circle becomes a client card in at least 90% of noisy strokes', () => {
    const misses: string[] = [];
    let n = 0;
    for (const r of [3, 5, 7]) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        n++;
        const { port, ops } = setup();
        const pts: Pt[] = [];
        const steps = Math.round((2 * Math.PI * r) / 0.5);
        for (let i = 0; i <= steps + 2; i++) {
          const a = -Math.PI / 2 + (i / steps) * 2 * Math.PI * (seed % 2 ? 1 : -1);
          pts.push([30 + r * Math.cos(a), 20 + r * Math.sin(a)]);
        }
        replay(port, pts, seed);
        const made = created(ops);
        if (made.length !== 1 || made[0] !== 'client') misses.push(`r ${r} seed ${seed}: ${made.join(',') || 'nothing'}`);
      }
    }
    expect(misses.length / n, misses.join('\n')).toBeLessThanOrEqual(0.1);
  });

  it('a line from a card edge to another card connects them in at least 95% of noisy strokes', () => {
    const misses: string[] = [];
    let n = 0;
    // Starts 0.4 cm inside the right edge (the rim) to 1.2 cm outside it, ends anywhere on the target's near half.
    for (const start of [-0.4, 0.3, 1.2]) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        n++;
        const { port, ops } = setup([
          { id: 'a', x: 6, y: 10, w: 8, h: 5 },
          { id: 'b', x: 40, y: 14, w: 8, h: 5 },
        ]);
        replay(port, along([[14 + start, 12.5], [42, 16.5]], 0.5), seed, { ...REAL, closeCm: 0.3 });
        const edges = ops.filter((o) => o.op === 'edge.create');
        if (edges.length !== 1) misses.push(`start ${start} seed ${seed}: ${ops.map((o) => o.op).join(',') || 'nothing'}`);
      }
    }
    expect(misses.length / n, misses.join('\n')).toBeLessThanOrEqual(0.05);
  });

  it('a short dropout in tracking mid stroke (100 to 250 ms) still makes one card', () => {
    for (const ms of [100, 180, 250]) {
      const { port, ops } = setup();
      replay(port, boxPath(20, 12, 12, 7, true, 0), 7, REAL, { loss: [{ at: 0.45, ms }] });
      expect(created(ops), `${ms} ms`).toEqual(['service']);
    }
  });
});

describe('noisy hands: the pinch lets go for a moment mid gesture', () => {
  it.each([30, 60, 100])('a box drawn through a %i ms pinch drop is still one card, not two strokes of ink', (ms) => {
    const { port, ops } = setup();
    replay(port, boxPath(20, 12, 12, 7, true, 0), 11, REAL, { release: [{ at: 0.5, ms }] });
    expect(created(ops)).toEqual(['service']);
  });

  it('two drops in one box still make one card', () => {
    const { port, ops } = setup();
    replay(port, boxPath(20, 12, 14, 8, false, 3), 12, REAL, { release: [{ at: 0.3, ms: 50 }, { at: 0.7, ms: 80 }] });
    expect(created(ops)).toEqual(['service']);
  });

  it('a card dragged through a pinch drop moves once, to where the hand let go', () => {
    const { port, ops, store } = setup([{ id: 'a', x: 10, y: 10, w: 8, h: 5 }]);
    replay(port, along([[14, 12.5], [34, 22.5]], 0.5), 13, { ...REAL, closeCm: 0.3 }, { release: [{ at: 0.5, ms: 70 }] });
    const moves = ops.filter((o) => o.op === 'item.move');
    expect(moves).toHaveLength(1);
    const it = store.board.items.find((i) => i.id === 'a') as { x: number; y: number };
    // The card's centre lands within a grid step of where the hand ended (34, 22.5).
    expect(Math.abs(it.x + 4 - 34)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(it.y + 2.5 - 22.5)).toBeLessThanOrEqual(1.5);
    expect(ops.some((o) => o.op === 'item.create')).toBe(false);
  });

  it('a connector pulled from a card tab through a pinch drop still connects', () => {
    const { port, ops, store } = setup([
      { id: 'a', x: 6, y: 10, w: 8, h: 5 },
      { id: 'b', x: 40, y: 14, w: 8, h: 5 },
    ]);
    // The pull tab sits just outside the card's top-right corner.
    const [tx, ty] = tabCenter(store.board.items[0]!);
    replay(port, along([[tx, ty], [43, 16.5]], 0.5), 14, { ...REAL, closeCm: 0.2 }, { release: [{ at: 0.5, ms: 60 }] });
    expect(ops.filter((o) => o.op === 'edge.create')).toHaveLength(1);
    expect(ops.some((o) => o.op === 'item.create' || o.op === 'item.move')).toBe(false);
  });

  it('a tap releases at once; only a drag waits to see if the pinch closes again', () => {
    const { port, store } = setup([{ id: 'a', x: 10, y: 10, w: 8, h: 5 }]);
    for (let i = 0; i < 12; i++) {
      port.handAt('right', 14, 12.5);
      port.frame();
    }
    port.select('right', 'start', 'hand');
    for (let i = 0; i < 6; i++) port.frame();
    port.select('right', 'end', 'hand');
    // Focus is set on the release itself, with no frame after it.
    expect(store.board.focus).toBe('a');
  });

  it('a pinch that closes again far from where it let go starts a new gesture, and the first one ends where it let go', () => {
    const { port, ops } = setup();
    const at = (x: number, y: number, n = 1) => {
      for (let i = 0; i < n; i++) {
        port.handAt('right', x, y);
        port.frame();
      }
    };
    at(10, 30, 12);
    port.select('right', 'start', 'hand');
    at(10, 30, 8);
    for (const [x, y] of along([[10, 30], [30, 30]], 0.4)) at(x, y);
    at(30, 30, 10);
    port.select('right', 'end', 'hand');
    // 70 ms later the other end of the sheet: not the same gesture.
    at(50, 8, 5);
    port.select('right', 'start', 'hand');
    at(50, 8, 8);
    for (const [x, y] of along([[50, 8], [50, 20]], 0.4)) at(x, y);
    at(50, 20, 10);
    port.select('right', 'end', 'hand');
    at(50, 20, 12);
    const inks = ops.filter((o) => o.op === 'item.create').map((o) => (o.args as { points: [number, number][] }).points);
    expect(inks).toHaveLength(2);
    expect(Math.max(...inks[0]!.map((p) => p[0]))).toBeLessThan(31);
    expect(Math.min(...inks[1]!.map((p) => p[1]))).toBeGreaterThan(6);
  });

  it('a pinch the system cancels mid drag that closes again within the tracking grace carries on', () => {
    const { port, ops } = setup();
    replay(port, boxPath(20, 12, 12, 7, true, 0), 21, REAL, {});
    const one = created(ops);
    const b = setup();
    // The same box, but the system cancels the pinch half way (selectend with no select) and it closes again 200 ms later.
    const origSelect = b.port.select.bind(b.port);
    let cancelled = false;
    b.port.select = (hand, phase, kind) => {
      if (phase === 'end' && !cancelled && b.port.now > 900) {
        cancelled = true;
        return origSelect(hand, 'cancel', kind);
      }
      return origSelect(hand, phase, kind);
    };
    replay(b.port, boxPath(20, 12, 12, 7, true, 0), 21, REAL, { release: [{ at: 0.5, ms: 200 }] });
    expect(cancelled).toBe(true);
    expect(one).toEqual(['service']);
    expect(created(b.ops)).toEqual(['service']);
  });

  it('two strokes with a real pause between them stay two strokes', () => {
    const { port, ops } = setup();
    replay(port, along([[10, 30], [30, 30]], 0.5), 15, REAL);
    replay(port, along([[34, 30], [54, 30]], 0.5), 16, REAL);
    expect(ops.filter((o) => o.op === 'item.create')).toHaveLength(2);
  });
});
