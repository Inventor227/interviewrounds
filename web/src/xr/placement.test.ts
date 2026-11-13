import { describe, expect, it } from 'vitest';
import { CONTROLLER_DWELL_MIN_DOWN, CONTROLLER_PAD, DeskPlacement, detectDeskDwell, type DwellSample } from './placement';

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
      s = p.update(t, head, [{ hand: 'left', tracked: true, indexTip: tip, thumbTip: tip, tips: [tip], pinch: 0 }]);
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
      s = p.update(t, head, [{ hand: 'right', tracked: true, indexTip: tip, thumbTip: tip, tips: [tip], pinch: 0 }]);
      if (s.state === 'done') break;
    }
    expect(s.state).toBe('done');
    expect(s.result!.source).toBe('fallback');
  });

  it('a_resting_hand_below_the_desk_band_is_not_a_desk', () => {
    // Below headY - 0.75 (a knee, a low lap): never a desk candidate, so the fallback wins.
    const p = new DeskPlacement(0);
    let s = p.update(0, head, []);
    const tip = { x: 0.1, y: HEAD_Y - 0.8, z: -0.3 };
    for (let t = 0; t <= 6100; t += 1000 / 72) {
      s = p.update(t, head, [{ hand: 'right', tracked: true, indexTip: tip, thumbTip: tip, tips: [tip], pinch: 0 }]);
      if (s.state === 'done') break;
    }
    expect(s.result!.source).toBe('fallback');
    expect(detectDeskDwell(track(700, 0, tip))).toBeNull();
  });

  it('a_rest_on_the_thigh_inside_the_band_is_accepted_as_documented', () => {
    // Accepted limit of the 0.25 to 0.75 m band: a seated thigh about 0.6 m below the eyes can still become the desk.
    // The prompt asks for the desk, and placement can be redone; checked on device.
    expect(detectDeskDwell(track(700, 0, { x: 0.1, y: HEAD_Y - 0.6, z: -0.3 }))).not.toBeNull();
  });

  it('a_real_dwell_past_the_timer_still_wins', () => {
    const p = new DeskPlacement(0);
    const still = { x: 0, y: 0.75, z: -0.4 };
    const hand = (tip: typeof still) => [{ hand: 'right' as const, tracked: true, indexTip: tip, thumbTip: tip, tips: [tip], pinch: 0 }];
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
        s = p.update(t, head, [{ hand: 'right', tracked: true, indexTip: tip, thumbTip: tip, tips: [tip], pinch: 0 }]);
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
      s = p.update(smp.t_ms, head, [{ hand: 'right', tracked: true, indexTip: smp.tip, thumbTip: smp.tip, tips: [smp.tip], pinch: 0 }]);
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
    const hand = { hand: 'right' as const, tracked: true, indexTip: tip, thumbTip: tip, tips: [tip], pinch: 0 };
    // Half a dwell (0.3 s of 0.6 s) is under way at 6 s: hold the fallback.
    for (let t = 5650; t < 6000; t += 1000 / 72) p.update(t, head, [hand]);
    expect(p.update(6000, head, [hand]).state).toBe('dwelling');
    expect(p.update(6450, head, [hand]).result?.source).toBe('touch');
  });
});

describe('desk placement with a controller', () => {
  const head = { pos: { x: 0, y: HEAD_Y, z: 0 }, yaw: 0.3, pitch: -0.4 };
  const noHands: never[] = [];
  /** A controller whose tip rests at `tip`, pointing 45 degrees down and forward. */
  const ctrl = (tip: { x: number; y: number; z: number }, pressed: boolean, dir = { x: 0, y: -Math.SQRT1_2, z: -Math.SQRT1_2 }, hand: 'left' | 'right' = 'right') => ({ hand, tracked: true, tip, dir, pressed });
  const DESK_TIP = { x: 0.12, y: 0.745, z: -0.42 };

  /** The tip rests at `tip` for `ms` (frames of 14 ms from t0); returns the last status and the time. */
  const restFor = (p: DeskPlacement, t0: number, ms: number, make: (pressed: boolean) => ReturnType<typeof ctrl>) => {
    let st = p.update(t0, head, noHands, [make(false)]);
    let t = t0;
    while (t < t0 + ms) {
      t += 14;
      st = p.update(t, head, noHands, [make(false)]);
    }
    return { st, t };
  };

  it('controller_places_desk_with_tip_offset', () => {
    const p = new DeskPlacement(0);
    // The tip rests on the desk for 0.35 s, pointing down at it; the trigger is not pulled yet.
    const { st: before, t } = restFor(p, 0, 350, (pressed) => ctrl(DESK_TIP, pressed));
    expect(before.state).toBe('dwelling');
    const st = p.update(t + 14, head, noHands, [ctrl(DESK_TIP, true)]);
    expect(st.state).toBe('done');
    const desk = st.result!;
    // The desk top is the tip minus the controller's contact pad: a few millimetres, not the 5 cm to the grip.
    expect(CONTROLLER_PAD).toBeLessThanOrEqual(0.008);
    expect(desk.deskY).toBeCloseTo(DESK_TIP.y - CONTROLLER_PAD, 6);
    expect(DESK_TIP.y - desk.deskY).toBeLessThan(0.01);
    // The sheet's near edge centre is under the tip, facing the way the head faces.
    expect(desk.origin.x).toBeCloseTo(DESK_TIP.x, 6);
    expect(desk.origin.y).toBeCloseTo(DESK_TIP.y - CONTROLLER_PAD, 6);
    expect(desk.origin.z).toBeCloseTo(DESK_TIP.z, 6);
    expect(desk.yaw).toBe(0.3);
    expect(desk.source).toBe('touch');
    // The hand that held it is the dominant one (the tray goes on the other side), as with a finger.
    expect(desk.hand).toBe('right');
    expect(desk.input).toBe('controllers');
  });

  it('a_trigger_while_the_ray_is_on_the_prompt_card_never_places', () => {
    // The usual way to "click" a card: the controller at chest height, level, its ray on the card, the trigger pulled.
    const p = new DeskPlacement(0, 60000);
    const chest = { x: 0.15, y: HEAD_Y - 0.3, z: -0.25 };
    const level = { x: 0, y: 0.1, z: -1 };
    let { st, t } = restFor(p, 0, 1000, (pressed) => ({ ...ctrl(chest, pressed, level), busy: true }));
    for (let k = 0; k < 5; k++) {
      st = p.update((t += 14), head, noHands, [{ ...ctrl(chest, true, level), busy: true }]);
      expect(st.state).toBe('waiting');
      st = p.update((t += 14), head, noHands, [{ ...ctrl(chest, false, level), busy: true }]);
    }
    // Not even when the controller happens to point down while its ray is on a card (a card low in view).
    ({ st, t } = restFor(p, t, 1000, (pressed) => ({ ...ctrl(chest, pressed), busy: true })));
    st = p.update((t += 14), head, noHands, [{ ...ctrl(chest, true), busy: true }]);
    expect(st.state).toBe('waiting');
    expect(st.result).toBeNull();
  });

  it('a_trigger_pulled_in_the_air_level_or_on_the_move_does_not_place', () => {
    const p = new DeskPlacement(0, 60000);
    // Level, perfectly still, in the band: a controller pointing at something, not touching a desk.
    let { st, t } = restFor(p, 0, 600, (pressed) => ctrl(DESK_TIP, pressed, { x: 0, y: 0, z: -1 }));
    st = p.update((t += 14), head, noHands, [ctrl(DESK_TIP, true, { x: 0, y: 0, z: -1 })]);
    expect(st.state).toBe('waiting');
    p.update((t += 14), head, noHands, [ctrl(DESK_TIP, false)]);
    // Pointing down but on its way down to the desk (20 cm a second): the pull does not place where it happens to be.
    for (let i = 0; i < 30; i++) st = p.update((t += 14), head, noHands, [ctrl({ ...DESK_TIP, y: DESK_TIP.y + 0.1 - i * 0.0028 }, false)]);
    st = p.update((t += 14), head, noHands, [ctrl({ ...DESK_TIP, y: DESK_TIP.y + 0.013 }, true)]);
    expect(st.state).not.toBe('done');
    // It arrives and rests only 0.15 s before the pull: too soon.
    p.update((t += 14), head, noHands, [ctrl(DESK_TIP, false)]);
    ({ st, t } = restFor(p, t, 150, (pressed) => ctrl(DESK_TIP, pressed)));
    st = p.update((t += 14), head, noHands, [ctrl(DESK_TIP, true)]);
    expect(st.state).not.toBe('done');
  });

  it('a_trigger_already_held_when_placement_starts_does_not_place', () => {
    const p = new DeskPlacement(0);
    // Held from the start while the tip rests (under the dwell time): no pull was seen.
    let t = 0;
    let st = p.update(t, head, noHands, [ctrl(DESK_TIP, true)]);
    while (t < 400) st = p.update((t += 14), head, noHands, [ctrl(DESK_TIP, true)]);
    expect(st.state).toBe('dwelling');
    // Let go and pull again: placed.
    p.update((t += 14), head, noHands, [ctrl(DESK_TIP, false)]);
    st = p.update((t += 14), head, noHands, [ctrl(DESK_TIP, true)]);
    expect(st.state).toBe('done');
  });

  it('a_trigger_pull_near_the_face_or_down_in_the_lap_does_not_place', () => {
    for (const y of [HEAD_Y - 0.1, HEAD_Y - 0.9]) {
      const p = new DeskPlacement(0, 60000);
      const { t } = restFor(p, 0, 500, (pressed) => ctrl({ ...DESK_TIP, y }, pressed));
      expect(p.update(t + 14, head, noHands, [ctrl({ ...DESK_TIP, y }, true)]).state).not.toBe('done');
    }
  });

  it('a_controller_tip_held_still_on_the_desk_places_after_the_dwell_like_a_finger', () => {
    const p = new DeskPlacement(0);
    let st = p.update(0, head, noHands, [ctrl(DESK_TIP, false)]);
    for (let t = 14; t <= 700 && st.state !== 'done'; t += 14) {
      st = p.update(t, head, noHands, [ctrl(DESK_TIP, false)]);
      if (t > 100 && st.state !== 'done') {
        // The ring fills under the tip, with the controller's pad.
        expect(st.state).toBe('dwelling');
        expect(st.pad).toBe(CONTROLLER_PAD);
        expect(st.hand).toBe('right');
      }
    }
    expect(st.state).toBe('done');
    expect(st.result!.deskY).toBeCloseTo(DESK_TIP.y - CONTROLLER_PAD, 6);
    expect(st.result!.input).toBe('controllers');
  });

  it('a_controller_lying_level_or_resting_in_the_lap_is_not_a_desk', () => {
    const p = new DeskPlacement(0, 60000);
    // Held level (not pointing down at a desk) and perfectly still for 2 s.
    for (let t = 0; t <= 2000; t += 14) {
      const st = p.update(t, head, noHands, [ctrl(DESK_TIP, false, { x: 0, y: -0.1, z: -1 }), ctrl({ x: -0.2, y: HEAD_Y - 0.55, z: -0.1 }, false, { x: 0, y: 0.2, z: -1 }, 'left')]);
      expect(st.state).toBe('waiting');
    }
    expect(CONTROLLER_DWELL_MIN_DOWN).toBeGreaterThan(0.25);
  });

  it('a_tracked_hand_wins_its_side_and_no_touch_still_falls_back', () => {
    const p = new DeskPlacement(0, 1000);
    const hand = { hand: 'right' as const, tracked: true, indexTip: { x: 0, y: HEAD_Y - 0.1, z: -0.3 }, thumbTip: { x: 0, y: HEAD_Y - 0.1, z: -0.3 }, tips: [], pinch: 0 };
    // The right hand is tracked (its controller lies on the desk with the trigger pressed against something).
    p.update(0, head, [hand], [ctrl(DESK_TIP, false)]);
    expect(p.update(14, head, [hand], [ctrl(DESK_TIP, true)]).state).toBe('waiting');
    const st = p.update(1001, head, [hand], [ctrl({ ...DESK_TIP, y: HEAD_Y }, false)]);
    expect(st.state).toBe('done');
    expect(st.result!.source).toBe('fallback');
  });
});
