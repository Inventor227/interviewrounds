import { describe, expect, it } from 'vitest';
import type { HeadSample } from '../shared/types';
import { HeadSampler } from './head';

const DEG = Math.PI / 180;
const HEAD = { x: 0, y: 1.2, z: 0 };
// Floor panelist straight ahead at eye height, 1.2 m away; a second one off to the right.
const TARGETS = [
  { id: 'daniel', pos: { x: 0, y: 1.2, z: -1.2 } },
  { id: 'ana', pos: { x: 0.75, y: 1.2, z: -1.2 } },
];

function sampler() {
  const sent: HeadSample[][] = [];
  const s = new HeadSampler({ send: (b) => sent.push(b) });
  s.setTargets('daniel', TARGETS);
  return { s, sent };
}

describe('HeadSampler', () => {
  it('head_sampler_marks_target_within_15deg', () => {
    const { s } = sampler();
    // 14 degrees to the left of the floor panelist: still looking at them.
    const a = s.tick(0, { pos: HEAD, yaw: 14 * DEG, pitch: 0 }, false)!;
    expect(a.target).toBe('daniel');
    expect(a.yaw).toBeCloseTo(14, 1);
    // 20 degrees to the left, nobody there.
    const b = s.tick(200, { pos: HEAD, yaw: 20 * DEG, pitch: 0 }, false)!;
    expect(b.target).toBeNull();
    // Looking down 16 degrees: off the floor panelist.
    const c = s.tick(400, { pos: HEAD, yaw: 0, pitch: -16 * DEG }, true)!;
    expect(c.target).toBeNull();
    expect(c.pitch).toBeCloseTo(-16, 1);
    expect(c.speaking).toBe(true);
    // Turned toward the second panelist (atan(0.75/1.2) = 32 degrees right).
    const d = s.tick(600, { pos: HEAD, yaw: -32 * DEG, pitch: 0 }, false)!;
    expect(d.target).toBe('ana');
  });

  it('samples_at_5_hz', () => {
    const { s } = sampler();
    const pose = { pos: HEAD, yaw: 0, pitch: 0 };
    let n = 0;
    for (let t = 0; t < 1000; t += 1000 / 72) if (s.tick(t, pose, false)) n++;
    expect(n).toBe(5);
  });

  it('batches_every_5_s', () => {
    const { s, sent } = sampler();
    const pose = { pos: HEAD, yaw: 0, pitch: 0 };
    for (let t = 0; t <= 4900; t += 100) s.tick(t, pose, false);
    expect(sent).toHaveLength(0);
    s.tick(5000, pose, false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBe(26);
    s.flush();
    expect(sent).toHaveLength(1);
    s.tick(5200, pose, false);
    s.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.map((x) => x.t_ms)).toEqual([5200]);
  });
});
