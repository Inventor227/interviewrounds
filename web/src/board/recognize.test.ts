import { describe, expect, it } from 'vitest';
import type { Board } from '../shared/types';
import { emptyBoard } from './model';
import { recognize } from './recognize';
import { along, jitter, roughBox, roughCircle, wobble, type Pt } from './testkit';

function twoCards(): Board {
  const b = emptyBoard();
  return {
    ...b,
    items: [
      { id: 'n1', kind: 'component', type: 'client', label: null, x: 4, y: 18, w: 8, h: 5 },
      { id: 'n2', kind: 'component', type: 'service', label: null, x: 24, y: 18, w: 8, h: 5 },
    ],
  };
}

describe('recognize', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('rough_rectangle_becomes_rect (wobble, seed %i)', (seed) => {
    const stroke = roughBox(10, 8, 9, 6, 0.6, seed);
    const r = recognize(stroke, emptyBoard());
    expect(r?.kind).toBe('rect');
    if (r?.kind !== 'rect') return;
    expect(Math.abs(r.x - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y - 8)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.x + r.w - 19)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y + r.h - 14)).toBeLessThanOrEqual(1);
    // Snapped to the 1 cm grid.
    for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
  });

  it.each([11, 12, 13, 14])('rough_rectangle_becomes_rect (independent ±0.6 cm noise, seed %i)', (seed) => {
    const r = recognize(roughBox(30, 20, 10, 6, 0.6, seed, 'jitter'), emptyBoard());
    expect(r?.kind).toBe('rect');
    if (r?.kind !== 'rect') return;
    expect(Math.abs(r.x - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.w - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.h - 6)).toBeLessThanOrEqual(1);
  });

  it('a small box under 3 x 2 cm stays ink', () => {
    expect(recognize(roughBox(10, 10, 2.2, 1.6, 0.1, 3), emptyBoard())?.kind).toBe('ink');
  });

  it('line_between_cards_becomes_connector', () => {
    const line = wobble(along([[10, 20], [26, 20.6]]), 0.3, 9);
    expect(recognize(line, twoCards())).toEqual({ kind: 'connector', from: 'n1', to: 'n2', arrow: false });
  });

  it('line_between_cards_becomes_connector: a 2-segment hook at the end is an arrow', () => {
    const shaft = along([[10, 20], [27, 20.5]]);
    const hook = along([[27, 20.5], [25.6, 19.2], [25.6, 21.8]]).slice(1);
    const r = recognize(wobble([...shaft, ...hook], 0.15, 4), twoCards());
    expect(r).toEqual({ kind: 'connector', from: 'n1', to: 'n2', arrow: true });
  });

  it('a stroke that starts just outside a card edge still connects it', () => {
    const line = along([[12.8, 20.5], [23.6, 20.5]]);
    expect(recognize(line, twoCards())).toMatchObject({ kind: 'connector', from: 'n1', to: 'n2' });
  });

  it('a hook whose tip misses still connects by the real end (no arrow then)', () => {
    // Shaft ends past n2's far side; the hook comes back into n2.
    const shaft = along([[10, 20], [36, 20.5]]);
    const hook = along([[36, 20.5], [30, 19.5], [29, 21.5]]).slice(1);
    expect(recognize(shaft.concat(hook), twoCards())).toEqual({ kind: 'connector', from: 'n1', to: 'n2', arrow: false });
  });

  it('a connector may end up to 1.5 cm short of the target card', () => {
    expect(recognize(along([[10, 20], [22.7, 20.5]]), twoCards())).toMatchObject({ kind: 'connector', to: 'n2' });
  });

  it('a line from a card into empty sheet stays ink', () => {
    expect(recognize(along([[10, 20], [18, 34]]), twoCards())).toEqual({ kind: 'ink' });
  });

  it('short_jitter_makes_no_mark', () => {
    const tiny = jitter(along([[30, 30], [30.6, 30.3]], 0.05), 0.08, 2);
    let len = 0;
    for (let i = 1; i < tiny.length; i++) len += Math.hypot(tiny[i]![0] - tiny[i - 1]![0], tiny[i]![1] - tiny[i - 1]![1]);
    expect(len).toBeGreaterThan(0.7);
    expect(len).toBeLessThan(1.5);
    expect(recognize(tiny, emptyBoard())).toBeNull();
    expect(recognize([[1, 1]], emptyBoard())).toBeNull();
  });

  it.each([1, 2, 3])('a rough circle becomes a circle (seed %i)', (seed) => {
    const r = recognize(roughCircle(40, 28, 3, 0.4, seed), emptyBoard());
    expect(r?.kind).toBe('circle');
    if (r?.kind !== 'circle') return;
    expect(Math.abs(r.cx - 40)).toBeLessThan(0.8);
    expect(Math.abs(r.cy - 28)).toBeLessThan(0.8);
    expect(Math.abs(r.r - 3)).toBeLessThan(0.8);
  });

  it('a slightly squashed ellipse is still a circle, a box is never one', () => {
    const ell: Pt[] = roughCircle(20, 20, 3, 0.2, 5).map(([x, y]) => [20 + (x - 20) * 1.3, y]);
    expect(recognize(ell, emptyBoard())?.kind).toBe('circle');
    expect(recognize(roughBox(10, 10, 5, 5, 0.3, 1), emptyBoard())?.kind).toBe('rect');
  });

  it('everything else stays ink: zigzag, open line, triangle, underline', () => {
    const zig = along([[5, 5], [7, 8], [9, 5], [11, 8], [13, 5], [15, 8]]);
    const tri = along([[30, 30], [36, 30], [33, 25], [30, 30]]);
    const under = along([[40, 10], [52, 10.3]]);
    const hook = along([[5, 30], [12, 30], [12, 36]]);
    for (const s of [zig, tri, under, hook]) expect(recognize(s, emptyBoard())).toEqual({ kind: 'ink' });
  });

  it('is fast: under 2 ms for a 200 point stroke (median of batches)', () => {
    const stroke = roughBox(10, 8, 12, 8, 0.6, 3, 'jitter');
    const pts = stroke.slice(0, 200);
    while (pts.length < 200) pts.push(stroke[pts.length % stroke.length]!);
    const board = twoCards();
    for (let i = 0; i < 20; i++) recognize(pts, board);
    const batches: number[] = [];
    for (let b = 0; b < 7; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) recognize(pts, board);
      batches.push((performance.now() - t0) / 20);
    }
    batches.sort((x, y) => x - y);
    // A shared CI host can be slow; the budget there is 4 ms.
    expect(batches[3]!).toBeLessThan(process.env.CI ? 4 : 2);
  });

});
