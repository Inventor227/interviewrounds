import { describe, expect, it } from 'vitest';
import { OneEuroFilter, pathLength, resample, simplify, StrokeBuilder } from './ink';
import { along, rng } from './testkit';

const variance = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

describe('OneEuroFilter', () => {
  /** A pinch point (metres, 72 Hz) following `truth`, with about 3 mm of tracking noise. */
  function run(truth: (tMs: number) => number, seed: number) {
    const r = rng(seed);
    const f = new OneEuroFilter();
    const raw: number[] = [];
    const out: number[] = [];
    const real: number[] = [];
    for (let i = 0; i < 72 * 6; i++) {
      const t = (i * 1000) / 72;
      // Sum of uniforms: roughly gaussian, sd 3 mm.
      const x = truth(t) + (r() + r() + r() - 1.5) * 0.006;
      const y = f.filter(x, t);
      if (i > 36) {
        raw.push(x);
        out.push(y);
        real.push(truth(t));
      }
    }
    return { raw, out, real };
  }
  /** Frame-to-frame wobble: second differences, which is what makes a drawn line look shaky. */
  const wobbleOf = (xs: number[]) => xs.slice(2).map((x, i) => x - 2 * xs[i + 1]! + xs[i]!);

  it('one_euro_reduces_jitter', () => {
    // Sine + noise: a hand drawing slowly back and forth over 6 cm.
    const sine = (t: number) => 0.03 * Math.sin((2 * Math.PI * 0.25 * t) / 1000);
    // (With these starting values the filter lags a moving hand by about 0.1 s; that is
    // the trade to tune on the headset, so this test measures jitter, not lag.)
    for (const seed of [7, 8, 9]) {
      const { raw, out } = run(sine, seed);
      expect(variance(wobbleOf(out))).toBeLessThan(0.3 * variance(wobbleOf(raw)));
    }
    // Held still, the noise itself drops below 30%.
    const still = run(() => 0.1, 3);
    expect(variance(still.out)).toBeLessThan(0.3 * variance(still.raw));
  });

  it('passes the first sample through and keeps up with a step after a while', () => {
    const f = new OneEuroFilter();
    expect(f.filter(1, 0)).toBe(1);
    let out = 1;
    for (let i = 1; i < 120; i++) out = f.filter(2, i * 14);
    expect(out).toBeGreaterThan(1.95);
  });

  it('ignores a repeated timestamp instead of dividing by zero', () => {
    const f = new OneEuroFilter();
    f.filter(1, 10);
    expect(Number.isFinite(f.filter(1.5, 10))).toBe(true);
  });
});

describe('simplify and resample', () => {
  it('drops points within eps of a straight run and keeps corners', () => {
    const pts = along([[0, 0], [10, 0], [10, 6]], 0.2);
    const s = simplify(pts);
    expect(s).toEqual([[0, 0], [10, 0], [10, 6]]);
  });

  it('keeps the end points of a short stroke', () => {
    expect(simplify([[1, 1]])).toEqual([[1, 1]]);
    expect(simplify([[1, 1], [2, 2]])).toEqual([[1, 1], [2, 2]]);
  });

  it('resamples to an even spacing', () => {
    const r = resample([[0, 0], [10, 0]], 0.5);
    expect(r.length).toBe(21);
    expect(pathLength(r)).toBeCloseTo(10, 5);
  });
});

describe('StrokeBuilder', () => {
  it('trims the pinch closing hook and opening flick on hand strokes only', () => {
    const hand = new StrokeBuilder('right');
    const mouse = new StrokeBuilder('mouse');
    for (let i = 0; i <= 50; i++) {
      // 50 points, 14 ms apart, 0.2 cm apart, along x
      hand.add(i * 0.2, 5, i * 14);
      mouse.add(i * 0.2, 5, i * 14);
    }
    const h = hand.points();
    const m = mouse.points();
    expect(m[0]![0]).toBeCloseTo(0);
    expect(m[m.length - 1]![0]).toBeCloseTo(10);
    expect(h[0]![0]).toBeGreaterThan(0.6);
    expect(h[h.length - 1]![0]).toBeLessThan(9.4);
  });

  it('keeps a quick hand stroke whole rather than trimming it to nothing', () => {
    const hand = new StrokeBuilder('left');
    hand.add(0, 0, 0);
    hand.add(1, 0, 30);
    hand.add(2, 0, 60);
    expect(hand.points().length).toBeGreaterThanOrEqual(2);
  });

  it('fits a very long scribble into the server limit of 5000 points', () => {
    const b = new StrokeBuilder('mouse');
    const r = rng(4);
    for (let i = 0; i < 20000; i++) b.add(5 + (i % 400) * 0.1 + r(), 5 + Math.floor(i / 400) * 0.6 + r(), i * 8);
    const pts = b.inkPoints();
    expect(pts.length).toBeLessThanOrEqual(5000);
    expect(pts.length).toBeGreaterThan(100);
  });

  it('rounds stored ink points to 1 decimal', () => {
    const b = new StrokeBuilder('mouse');
    b.add(1.234, 2.345, 0);
    b.add(5.678, 2.349, 20);
    expect(b.inkPoints()).toEqual([[1.2, 2.3], [5.7, 2.3]]);
  });
});
