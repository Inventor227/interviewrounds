import { describe, expect, it } from 'vitest';
import { BLINK_MS, Blinker, blinkCurve, nextBlinkMs } from './blink';
import { seededRng } from './rng';

describe('blink', () => {
  it('blink_interval_in_range', () => {
    const rng = seededRng(7);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 1000; i++) {
      const ms = nextBlinkMs(rng);
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThanOrEqual(6000);
      lo = Math.min(lo, ms);
      hi = Math.max(hi, ms);
    }
    // Uniform, not a constant: the samples cover most of the range.
    expect(lo).toBeLessThan(2200);
    expect(hi).toBeGreaterThan(5800);
  });

  it('blink_lasts_140_ms_and_closes_fully', () => {
    expect(BLINK_MS).toBe(140);
    expect(blinkCurve(0)).toBe(0);
    expect(blinkCurve(60)).toBeCloseTo(1, 5);
    expect(blinkCurve(BLINK_MS)).toBe(0);
    expect(blinkCurve(BLINK_MS + 10)).toBe(0);
    // Closing is faster than opening.
    expect(blinkCurve(25)).toBeGreaterThan(blinkCurve(BLINK_MS - 25));
  });

  it('blinker_blinks_on_schedule_and_on_trigger', () => {
    const b = new Blinker(seededRng(3));
    let closedFrames = 0;
    let blinks = 0;
    let wasClosed = false;
    // 60 s at 100 Hz: 10 to 30 blinks with 2 to 6 s gaps (plus rare doubles).
    for (let i = 0; i < 6000; i++) {
      const w = b.update(10);
      const closed = w > 0.5;
      if (closed) closedFrames++;
      if (closed && !wasClosed) blinks++;
      wasClosed = closed;
    }
    expect(blinks).toBeGreaterThanOrEqual(10);
    expect(blinks).toBeLessThanOrEqual(36);
    expect(closedFrames).toBeLessThan(blinks * 10);

    const t = new Blinker(seededRng(4));
    t.update(10);
    t.trigger();
    let peak = 0;
    for (let i = 0; i < 10; i++) peak = Math.max(peak, t.update(10));
    expect(peak).toBeGreaterThan(0.9);
  });
});
