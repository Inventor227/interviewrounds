import { describe, expect, it } from 'vitest';
import { FrameRateGovernor } from './framerate';

/** Feeds frames of `ms` CPU time at `hz` for `seconds`, returning the decisions made. */
function run(g: FrameRateGovernor, ms: number, hz: number, seconds: number, t0 = 0): (72 | 90)[] {
  const out: (72 | 90)[] = [];
  for (let t = t0; t < t0 + seconds * 1000; t += 1000 / hz) {
    const d = g.frame(ms, t);
    if (d) out.push(d);
  }
  return out;
}

describe('FrameRateGovernor', () => {
  it('starts_at_72_and_raises_to_90_after_5_s_under_9_ms', () => {
    const g = new FrameRateGovernor([72, 90]);
    expect(g.rate).toBe(72);
    expect(run(g, 6, 72, 4.5)).toEqual([]);
    expect(run(g, 6, 72, 1, 4500)).toEqual([90]);
  });

  it('stays_at_72_when_frames_are_heavy', () => {
    const g = new FrameRateGovernor([72, 90]);
    expect(run(g, 9.6, 72, 20)).toEqual([]);
    expect(g.rate).toBe(72);
  });

  it('a_few_slow_frames_above_the_95th_percentile_do_not_block_the_raise', () => {
    const g = new FrameRateGovernor([72, 90]);
    let n = 0;
    const out: number[] = [];
    for (let t = 0; t < 6000; t += 1000 / 72) {
      const d = g.frame(n++ % 50 === 0 ? 20 : 6, t);
      if (d) out.push(d);
    }
    expect(out).toEqual([90]);
  });

  it('drops_back_to_72_when_90_hz_frames_run_over_11_ms', () => {
    const g = new FrameRateGovernor([72, 90]);
    run(g, 6, 72, 6);
    expect(g.rate).toBe(90);
    expect(run(g, 12, 90, 6, 6000)).toEqual([72]);
    // And it does not try 90 again in the same session.
    expect(run(g, 5, 72, 20, 12000)).toEqual([]);
  });

  it('never_raises_when_90_is_not_offered', () => {
    const g = new FrameRateGovernor([72]);
    expect(run(g, 4, 72, 20)).toEqual([]);
  });
});
