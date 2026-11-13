import { describe, expect, it } from 'vitest';
import { frameStats, hitStats, jitter, levelSummary, percentile, PinchCounter, rms, selectRatio, straightness, toDb } from './stats';

describe('percentile', () => {
  it('interpolates between sorted values', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBeCloseTo(9.1, 6);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([1, 2], 0)).toBe(1);
    expect(percentile([1, 2], 100)).toBe(2);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('frameStats', () => {
  it('reports percentiles, fps and late frames against the period', () => {
    const period = 1000 / 72;
    // 98 good frames and two missed vsyncs (a frame shown one period late).
    const xs = [...Array.from({ length: 98 }, () => period), 2 * period, 2 * period];
    const s = frameStats(xs, period)!;
    expect(s.frames).toBe(100);
    expect(s.late_pct).toBe(2);
    expect(s.p50_ms).toBeCloseTo(13.89, 2);
    expect(s.p99_ms).toBeCloseTo(27.78, 1);
    expect(s.max_ms).toBeCloseTo(27.78, 1);
    expect(s.fps).toBeCloseTo(70.6, 1);
    expect(s.seconds).toBeCloseTo(1.4, 1);
  });

  it('ignores non positive intervals and returns null when empty', () => {
    expect(frameStats([], 11.1)).toBeNull();
    expect(frameStats([0, -3, NaN], 11.1)).toBeNull();
    expect(frameStats([0, 11.1, 11.1], 11.1)!.frames).toBe(2);
  });

  it('a frame just under 1.5 periods is not late', () => {
    expect(frameStats([1.49 * 10, 10], 10)!.late_pct).toBe(0);
    expect(frameStats([1.51 * 10, 10], 10)!.late_pct).toBe(50);
  });
});

describe('jitter', () => {
  it('is zero for a point held perfectly still', () => {
    expect(jitter([{ x: 3, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 4 }])).toEqual({ n: 3, rms_cm: 0, max_cm: 0 });
  });

  it('is the RMS distance from the mean point', () => {
    // Four points on a circle of radius 0.5 cm around (10, 10).
    const pts = [
      { x: 10.5, y: 10 },
      { x: 9.5, y: 10 },
      { x: 10, y: 10.5 },
      { x: 10, y: 9.5 },
    ];
    const j = jitter(pts)!;
    expect(j.rms_cm).toBeCloseTo(0.5, 6);
    expect(j.max_cm).toBeCloseTo(0.5, 6);
  });

  it('needs two points', () => {
    expect(jitter([{ x: 1, y: 1 }])).toBeNull();
  });
});

describe('straightness', () => {
  const from = { x: 27, y: 24 };
  const to = { x: 37, y: 24 };

  it('a perfect line on target has no error', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: 27 + i, y: 24 }));
    const s = straightness(pts, from, to)!;
    expect(s.rms_cm).toBe(0);
    expect(s.max_cm).toBe(0);
    expect(s.length_cm).toBe(10);
    expect(s.path_cm).toBe(10);
    expect(s.angle_deg).toBe(0);
    expect(s.start_err_cm).toBe(0);
    expect(s.end_err_cm).toBe(0);
  });

  it('measures the wobble around the best fit line, not the target', () => {
    // A straight line 1 cm below the target with a 0.2 cm zigzag.
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: 27 + i * 0.5, y: 25 + (i % 2 === 0 ? 0.2 : -0.2) }));
    const s = straightness(pts, from, to)!;
    expect(s.rms_cm).toBeCloseTo(0.2, 1);
    expect(s.max_cm).toBeCloseTo(0.2, 1);
    expect(s.angle_deg).toBeLessThan(1);
    expect(s.start_err_cm).toBe(1.2);
  });

  it('finds the line for any direction, including vertical', () => {
    const pts = Array.from({ length: 11 }, (_, i) => ({ x: 5, y: i }));
    const s = straightness(pts, { x: 0, y: 0 }, { x: 10, y: 0 })!;
    expect(s.rms_cm).toBe(0);
    expect(s.angle_deg).toBe(90);
  });

  it('reports a bow as max deviation', () => {
    // A shallow arc: 0 at the ends, 1 cm in the middle.
    const pts = Array.from({ length: 41 }, (_, i) => {
      const x = i / 4;
      return { x, y: 1 - ((x - 5) / 5) ** 2 };
    });
    const s = straightness(pts)!;
    expect(s.max_cm).toBeGreaterThan(0.4);
    expect(s.max_cm).toBeLessThan(0.8);
    expect(s.start_err_cm).toBeNull();
    expect(s.angle_deg).toBeNull();
  });
});

describe('hitStats', () => {
  it('counts hits inside the radius and the mean offset', () => {
    const t = { x: 10, y: 10 };
    const taps = [
      { target: t, at: { x: 11, y: 10 } },
      { target: t, at: { x: 10, y: 11.5 } },
      { target: t, at: { x: 13, y: 10 } },
      { target: t, at: { x: 10, y: 10 } },
    ];
    const h = hitStats(taps, 2)!;
    expect(h.taps).toBe(4);
    expect(h.hits).toBe(3);
    expect(h.rate).toBe(0.75);
    expect(h.mean_dx_cm).toBe(1);
    expect(h.mean_dy_cm).toBeCloseTo(0.38, 2);
    expect(h.max_dist_cm).toBe(3);
    expect(h.mean_dist_cm).toBeCloseTo(1.38, 2);
  });

  it('is null without taps', () => {
    expect(hitStats([], 2)).toBeNull();
  });
});

describe('PinchCounter', () => {
  it('counts a closure once until the fingers open past the release point', () => {
    const c = new PinchCounter();
    const seq = [0, 0.5, 0.9, 1, 0.7, 0.9, 0.3, 0.95, 0.1];
    const news = seq.map((v) => c.feed(v));
    expect(c.count).toBe(2);
    expect(news.filter(Boolean).length).toBe(2);
  });

  it('a lost hand resets the state', () => {
    const c = new PinchCounter();
    c.feed(1);
    c.feed(null);
    c.feed(1);
    expect(c.count).toBe(2);
  });
});

describe('levels', () => {
  it('rms and dBFS', () => {
    expect(rms([1, -1, 1, -1])).toBe(1);
    expect(toDb(1)).toBe(0);
    expect(toDb(0.1)).toBe(-20);
    expect(toDb(0)).toBe(-100);
    expect(toDb(1e-9)).toBe(-100);
  });

  it('summarises a level series', () => {
    const s = levelSummary([-60, -60, -60, -20, -10])!;
    expect(s.p20_db).toBe(-60);
    expect(s.max_db).toBe(-10);
    expect(levelSummary([])).toBeNull();
  });

  it('select ratio', () => {
    expect(selectRatio(9, 10)).toBe(0.9);
    expect(selectRatio(3, 0)).toBeNull();
  });
});
