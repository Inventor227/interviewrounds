import { describe, expect, it } from 'vitest';
import { DeskPlacement, detectDeskDwell, type DwellSample } from './placement';

const HEAD_Y = 1.2;

/** Samples every 1000/72 ms from t0 for durMs, the tip moving at speed (m/s) along +x. */
function track(durMs: number, speed: number, start = { x: 0.1, y: 0.752, z: -0.45 }, t0 = 1000): DwellSample[] {
  const out: DwellSample[] = [];
  for (let t = 0; t <= durMs; t += 1000 / 72) {
    out.push({ t_ms: t0 + t, tip: { x: start.x + (speed * t) / 1000, y: start.y, z: start.z }, headY: HEAD_Y });
  }
  return out;
}

describe('detectDeskDwell', () => {
  it('dwell_detects_resting_tip', () => {
    const r = detectDeskDwell(track(700, 0));
    expect(r).not.toBeNull();
    expect(r!.deskY).toBeCloseTo(0.752 - 0.008, 4);
    expect(r!.at.x).toBeCloseTo(0.1, 3);
    expect(r!.at.z).toBeCloseTo(-0.45, 3);
  });

  it('dwell_ignores_moving_tip', () => {
    expect(detectDeskDwell(track(700, 0.03))).toBeNull();
  });

  it('dwell_needs_the_full_0_6_s', () => {
    expect(detectDeskDwell(track(450, 0))).toBeNull();
  });

  it('dwell_ignores_a_tip_near_the_face', () => {
    expect(detectDeskDwell(track(700, 0, { x: 0, y: HEAD_Y - 0.2, z: -0.3 }))).toBeNull();
  });

  it('dwell_ignores_a_tip_that_is_not_the_lowest', () => {
    const s = track(700, 0).map((x) => ({ ...x, tips: [x.tip, { ...x.tip, y: x.tip.y - 0.03 }] }));
    expect(detectDeskDwell(s)).toBeNull();
  });

  it('dwell_tolerates_tracking_jitter', () => {
    const s = track(700, 0).map((x, i) => ({ ...x, tip: { ...x.tip, x: x.tip.x + (i % 2 ? 0.002 : -0.002) } }));
    expect(detectDeskDwell(s)).not.toBeNull();
  });
});

describe('DeskPlacement', () => {
  const head = { pos: { x: 0, y: HEAD_Y, z: 0 }, yaw: 0.3, pitch: -0.4 };

  it('fallback_after_6s', () => {
    const p = new DeskPlacement(0);
    expect(p.update(5999, head, []).state).toBe('waiting');
    const s = p.update(6000, head, []);
    expect(s.state).toBe('done');
    expect(s.result!.source).toBe('fallback');
    expect(s.result!.deskY).toBeCloseTo(HEAD_Y - 0.45, 6);
    expect(s.result!.yaw).toBeCloseTo(0.3, 6);
    // The sheet's near edge lands 0.2 m ahead of the head, on the assumed desk.
    expect(Math.hypot(s.result!.origin.x - head.pos.x, s.result!.origin.z - head.pos.z)).toBeCloseTo(0.2, 6);
    expect(s.result!.head).toEqual(head.pos);
  });

  it('fallback_with_hands_in_view_but_no_rest', () => {
    // Hands waving in front of the face never rest on a desk: still the fallback at 6 s.
    const p = new DeskPlacement(0);
    let s = p.update(0, head, []);
    for (let t = 0; t <= 6000; t += 50) {
      const tip = { x: Math.sin(t / 100) * 0.1, y: 1.05, z: -0.35 };
      s = p.update(t, head, [{ hand: 'left', tracked: true, indexTip: tip, tips: [tip], pinch: 0 }]);
    }
    expect(s.state).toBe('done');
    expect(s.result!.source).toBe('fallback');
    expect(s.result!.deskY).toBeCloseTo(HEAD_Y - 0.45, 6);
  });

  it('fallback_runs_on_the_clock_while_a_low_hand_keeps_moving', () => {
    // A hand fidgeting at desk height (6 cm/s back and forth, never resting 0.6 s) must not hold off the fallback.
    const p = new DeskPlacement(0);
    let s = p.update(0, head, []);
    const tri = (t: number) => {
      const ph = (t / 2000) % 2;
      return ph < 1 ? ph : 2 - ph;
    };
    for (let t = 0; t <= 6100; t += 1000 / 72) {
      const tip = { x: 0.12 * tri(t), y: 0.75, z: -0.4 };
      s = p.update(t, head, [{ hand: 'right', tracked: true, indexTip: tip, tips: [tip], pinch: 0 }]);
      if (s.state === 'done') break;
    }
    expect(s.state).toBe('done');
    expect(s.result!.source).toBe('fallback');
  });

  it('a_resting_hand_in_the_lap_is_not_a_desk', () => {
    // Below headY - 0.75 (a lap or a knee): never a desk candidate, so the fallback wins.
    const p = new DeskPlacement(0);
    let s = p.update(0, head, []);
    const tip = { x: 0.1, y: HEAD_Y - 0.8, z: -0.3 };
    for (let t = 0; t <= 6100; t += 1000 / 72) {
      s = p.update(t, head, [{ hand: 'right', tracked: true, indexTip: tip, tips: [tip], pinch: 0 }]);
      if (s.state === 'done') break;
    }
    expect(s.result!.source).toBe('fallback');
    expect(detectDeskDwell(track(700, 0, tip))).toBeNull();
  });

  it('a_real_dwell_past_the_timer_still_wins', () => {
    const p = new DeskPlacement(0);
    const still = { x: 0, y: 0.75, z: -0.4 };
    const hand = (tip: typeof still) => [{ hand: 'right' as const, tracked: true, indexTip: tip, tips: [tip], pinch: 0 }];
    // A dwell that starts at 5.6 s is half way at 6 s: it is allowed to finish.
    for (let t = 5600; t < 6000; t += 1000 / 72) p.update(t, head, hand(still));
    let s = p.update(6000, head, hand(still));
    expect(s.state).toBe('dwelling');
    for (let t = 6000; t <= 6400 && s.state !== 'done'; t += 1000 / 72) s = p.update(t, head, hand(still));
    expect(s.result?.source).toBe('touch');
  });

  it('near_misses_cannot_hold_off_the_fallback_forever', () => {
    // Rest 0.45 s, hop 5 cm, rest again: never a full dwell. The wait is capped.
    const p = new DeskPlacement(0);
    let s = p.update(0, head, []);
    let t = 5000;
    for (let k = 0; t < 12000 && s.state !== 'done'; k++) {
      const tip = { x: (k % 2) * 0.05, y: 0.75, z: -0.4 };
      for (const end = t + 450; t < end && s.state !== 'done'; t += 1000 / 72) {
        s = p.update(t, head, [{ hand: 'right', tracked: true, indexTip: tip, tips: [tip], pinch: 0 }]);
      }
    }
    expect(s.state).toBe('done');
    expect(s.result!.source).toBe('fallback');
    expect(t).toBeLessThanOrEqual(7600);
  });

  it('touch_places_the_desk_at_the_tip', () => {
    const p = new DeskPlacement(0);
    let s = p.update(0, head, []);
    for (const smp of track(800, 0, undefined, 500)) {
      s = p.update(smp.t_ms, head, [{ hand: 'right', tracked: true, indexTip: smp.tip, tips: [smp.tip], pinch: 0 }]);
      if (s.state === 'done') break;
    }
    expect(s.state).toBe('done');
    expect(s.result!.source).toBe('touch');
    expect(s.result!.hand).toBe('right');
    expect(s.result!.deskY).toBeCloseTo(0.744, 3);
    expect(s.result!.origin.y).toBeCloseTo(0.744, 3);
  });

  it('a_dwell_in_progress_holds_off_the_fallback', () => {
    const p = new DeskPlacement(0);
    const tip = { x: 0, y: 0.75, z: -0.4 };
    const hand = { hand: 'right' as const, tracked: true, indexTip: tip, tips: [tip], pinch: 0 };
    // Half a dwell (0.3 s of 0.6 s) is under way at 6 s: hold the fallback.
    for (let t = 5650; t < 6000; t += 1000 / 72) p.update(t, head, [hand]);
    expect(p.update(6000, head, [hand]).state).toBe('dwelling');
    expect(p.update(6450, head, [hand]).result?.source).toBe('touch');
  });
});
