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

  it('blink_lasts_180_ms_and_closes_fully', () => {
    expect(BLINK_MS).toBe(180);
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
    expect(closedFrames).toBeLessThan(blinks * 12);

    const t = new Blinker(seededRng(4));
    t.update(10);
    t.trigger();
    let peak = 0;
    for (let i = 0; i < 10; i++) peak = Math.max(peak, t.update(10));
    expect(peak).toBeGreaterThan(0.9);
  });

  it('blink_pace_follows_the_conversation', () => {
    const rng = seededRng(11);
    const mean = (pace: Parameters<typeof nextBlinkMs>[1]) => {
      let s = 0;
      for (let i = 0; i < 2000; i++) s += nextBlinkMs(rng, pace);
      return s / 2000;
    };
    // Attentive listening blinks least often, speaking and thinking more often than idle.
    expect(mean('listening')).toBeGreaterThan(mean('idle'));
    expect(mean('speaking')).toBeLessThan(mean('idle'));
    expect(mean('thinking')).toBeLessThan(mean('speaking'));
    // A switch to a faster pace does not leave a long wait from the slower one.
    const b = new Blinker(seededRng(5));
    b.setPace('thinking');
    let first = -1;
    for (let i = 0; i < 500 && first < 0; i++) if (b.update(10) > 0) first = i * 10;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(4000);
  });
});
