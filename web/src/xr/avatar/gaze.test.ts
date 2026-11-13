import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { DEG, GazeController, HEAD_PITCH_MAX, HEAD_YAW_MAX, anglesTo, gazeTarget, nextSaccadeMs } from './gaze';
import { seededRng } from './rng';

const head = new Vector3(0, 1.3, 0);

describe('gaze', () => {
  it('gaze_clamps_head_turn', () => {
    expect(HEAD_YAW_MAX).toBeCloseTo(35 * DEG);
    expect(HEAD_PITCH_MAX).toBeCloseTo(20 * DEG);
    // User far to the avatar's side, far above, far below, behind: the aim never leaves the cone.
    const users = [
      new Vector3(1.5, 1.3, 0.2),
      new Vector3(-1.5, 1.3, 0.2),
      new Vector3(0, 3.5, 0.8),
      new Vector3(0.2, -0.5, 0.8),
      new Vector3(0.3, 1.3, -1),
    ];
    for (const user of users) {
      for (const t of [0, 1.7, 9.3]) {
        const aim = gazeTarget(head, user, t);
        const a = anglesTo(head, aim);
        expect(Math.abs(a.yaw)).toBeLessThanOrEqual(HEAD_YAW_MAX + 1e-6);
        expect(Math.abs(a.pitch)).toBeLessThanOrEqual(HEAD_PITCH_MAX + 1e-6);
      }
    }
    // Straight ahead: the aim stays on the user (only a tiny idle sway).
    const user = new Vector3(0, 1.25, 1.2);
    const a = anglesTo(head, gazeTarget(head, user, 2));
    const u = anglesTo(head, user);
    expect(Math.abs(a.yaw - u.yaw)).toBeLessThan(2 * DEG);
    expect(Math.abs(a.pitch - u.pitch)).toBeLessThan(2 * DEG);
    // Same distance as the user.
    expect(gazeTarget(head, user, 0).distanceTo(head)).toBeCloseTo(user.distanceTo(head), 5);
  });

  it('gaze_eyes_lead_head', () => {
    const g = new GazeController(seededRng(1));
    g.setMode('speaking');
    g.saccadesEnabled = false;
    const target = { yaw: 25 * DEG, pitch: 5 * DEG };
    g.update(0.1, target);
    // After 100 ms the eyes are most of the way there, the head is not.
    expect(g.eyeYaw / target.yaw).toBeGreaterThan(0.8);
    expect(g.headYaw / target.yaw).toBeLessThan(0.5);
    for (let i = 0; i < 200; i++) g.update(1 / 60, target);
    expect(g.headYaw).toBeCloseTo(target.yaw, 2);
    expect(g.eyeYaw).toBeCloseTo(target.yaw, 2);
  });

  it('gaze_head_clamped_eyes_cover_the_rest', () => {
    const g = new GazeController(seededRng(2));
    g.saccadesEnabled = false;
    const target = { yaw: 60 * DEG, pitch: -30 * DEG };
    for (let i = 0; i < 300; i++) g.update(1 / 60, target);
    expect(g.headYaw).toBeCloseTo(HEAD_YAW_MAX, 3);
    expect(g.headPitch).toBeCloseTo(-HEAD_PITCH_MAX, 3);
    expect(g.eyeYaw).toBeCloseTo(60 * DEG, 2);
    expect(g.eyePitch).toBeCloseTo(-30 * DEG, 2);
  });

  it('saccade_interval_in_range', () => {
    const rng = seededRng(11);
    for (let i = 0; i < 1000; i++) {
      const ms = nextSaccadeMs(rng);
      expect(ms).toBeGreaterThanOrEqual(800);
      expect(ms).toBeLessThanOrEqual(2500);
    }
  });

  it('listening_micro_saccades_stay_small', () => {
    const g = new GazeController(seededRng(5));
    g.setMode('listening');
    const target = { yaw: 0, pitch: 0 };
    let moves = 0;
    let last = 0;
    let maxOff = 0;
    for (let i = 0; i < 60 * 20; i++) {
      g.update(1 / 60, target);
      maxOff = Math.max(maxOff, Math.hypot(g.eyeYaw, g.eyePitch));
      if (Math.abs(g.eyeYaw - last) > 0.2 * DEG) moves++;
      last = g.eyeYaw;
    }
    // 20 s of listening: some micro-saccades, all within about 2 degrees of the user.
    expect(moves).toBeGreaterThan(4);
    expect(maxOff).toBeLessThanOrEqual(2.05 * DEG);
  });

  it('thinking_looks_up_and_away_then_back', () => {
    const g = new GazeController(seededRng(6));
    g.setMode('thinking');
    const target = { yaw: 0, pitch: 0 };
    let maxPitch = 0;
    let maxYaw = 0;
    for (let i = 0; i < 30; i++) {
      // first 0.5 s
      g.update(1 / 60, target);
      maxPitch = Math.max(maxPitch, g.eyePitch);
      maxYaw = Math.max(maxYaw, g.eyeYaw);
    }
    expect(maxPitch).toBeGreaterThan(8 * DEG);
    expect(maxYaw).toBeGreaterThan(8 * DEG);
    for (let i = 0; i < 60; i++) g.update(1 / 60, target);
    // 1.5 s in: back on the user (within micro-saccade range).
    expect(Math.hypot(g.eyeYaw, g.eyePitch)).toBeLessThan(2.5 * DEG);
  });

  it('gaze_target_behind_holds_one_side', () => {
    const g = new GazeController(seededRng(8));
    g.saccadesEnabled = false;
    // Come round from the left, then jitter across the back (atan2 flips between +179 and -179 degrees).
    for (let i = 0; i < 120; i++) g.update(1 / 60, { yaw: 95 * DEG, pitch: 0 });
    let flips = 0;
    let shifts = 0;
    let last = g.headYaw;
    for (let i = 0; i < 240; i++) {
      const yaw = (i % 2 ? 179 : -179) * DEG;
      g.update(1 / 60, { yaw, pitch: 0 });
      if (Math.sign(g.headYaw) !== Math.sign(last)) flips++;
      if (g.bigShift) shifts++;
      last = g.headYaw;
    }
    expect(flips).toBe(0);
    expect(shifts).toBe(0);
    expect(g.headYaw).toBeCloseTo(HEAD_YAW_MAX, 3);
  });
});
