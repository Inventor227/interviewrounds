import { describe, expect, it } from 'vitest';
import { FrameRateGovernor } from './framerate';

/**
 * Feeds frames at `hz` for `seconds`: each frame has `cpu` ms of work and arrives `late` times the period apart
 * when `lateEvery` hits (a dropped frame shows up as a long interval). Returns the decisions made.
 */
function run(
  g: FrameRateGovernor,
  o: { cpu: number; hz: number; seconds: number; t0?: number; lateEvery?: number },
): (72 | 90)[] {
  const out: (72 | 90)[] = [];
  const period = 1000 / o.hz;
  let n = 0;
  let t = o.t0 ?? 0;
  const end = t + o.seconds * 1000;
  while (t < end) {
    const interval = o.lateEvery && n % o.lateEvery === 0 ? period * 2 : period;
    t += interval;
    n++;
    const d = g.frame(o.cpu, interval, t);
    if (d) out.push(d);
  }
  return out;
}

describe('FrameRateGovernor', () => {
  it('does_nothing_until_armed', () => {
    const g = new FrameRateGovernor([72, 90]);
    expect(run(g, { cpu: 4, hz: 72, seconds: 20 })).toEqual([]);
    expect(g.rate).toBe(72);
  });

  it('raises_to_90_after_5_s_of_headroom_once_armed', () => {
    const g = new FrameRateGovernor([72, 90]);
    g.arm(0);
    expect(run(g, { cpu: 6, hz: 72, seconds: 4.5 })).toEqual([]);
    expect(run(g, { cpu: 6, hz: 72, seconds: 1, t0: 4500 })).toEqual([90]);
  });

  it('stays_at_72_when_cpu_is_heavy_or_frames_are_dropped', () => {
    const heavy = new FrameRateGovernor([72, 90]);
    heavy.arm(0);
    expect(run(heavy, { cpu: 9.6, hz: 72, seconds: 20 })).toEqual([]);
    const dropping = new FrameRateGovernor([72, 90]);
    dropping.arm(0);
    // 1 frame in 20 arrives late at 72 Hz: the GPU is already short of time.
    expect(run(dropping, { cpu: 5, hz: 72, seconds: 20, lateEvery: 20 })).toEqual([]);
  });

  it('drops_to_72_when_90_hz_frames_arrive_late_even_with_light_cpu', () => {
    const g = new FrameRateGovernor([72, 90]);
    g.arm(0);
    run(g, { cpu: 5, hz: 72, seconds: 6 });
    expect(g.rate).toBe(90);
    // GPU bound at 90: 1 interval in 10 doubles, CPU time stays low.
    expect(run(g, { cpu: 5, hz: 90, seconds: 6, t0: 6000, lateEvery: 10 })).toEqual([72]);
  });

  it('waits_before_trying_again_and_gives_up_after_two_drops', () => {
    const g = new FrameRateGovernor([72, 90]);
    g.arm(0);
    run(g, { cpu: 5, hz: 72, seconds: 6 }); // up
    run(g, { cpu: 12, hz: 90, seconds: 6, t0: 6000 }); // down (1)
    expect(g.rate).toBe(72);
    // Hysteresis: no new attempt within 30 s of a drop.
    expect(run(g, { cpu: 5, hz: 72, seconds: 20, t0: 12000 })).toEqual([]);
    expect(run(g, { cpu: 5, hz: 72, seconds: 20, t0: 32000 })).toEqual([90]);
    expect(run(g, { cpu: 12, hz: 90, seconds: 6, t0: 52000 })).toEqual([72]); // down (2)
    expect(run(g, { cpu: 4, hz: 72, seconds: 120, t0: 58000 })).toEqual([]);
  });

  it('rearming_restarts_the_window', () => {
    const g = new FrameRateGovernor([72, 90]);
    g.arm(0);
    run(g, { cpu: 6, hz: 72, seconds: 4 });
    g.arm(4000); // people loaded: measure the full scene from here
    expect(run(g, { cpu: 6, hz: 72, seconds: 4.5, t0: 4000 })).toEqual([]);
  });

  it('a_refused_raise_reverts_to_72', () => {
    const g = new FrameRateGovernor([72, 90]);
    g.arm(0);
    run(g, { cpu: 5, hz: 72, seconds: 6 });
    expect(g.rate).toBe(90);
    g.refused();
    expect(g.rate).toBe(72);
    expect(run(g, { cpu: 4, hz: 72, seconds: 120, t0: 6000 })).toEqual([]);
  });

  it('never_raises_when_90_is_not_offered', () => {
    const g = new FrameRateGovernor([72]);
    g.arm(0);
    expect(run(g, { cpu: 4, hz: 72, seconds: 20 })).toEqual([]);
  });
});
