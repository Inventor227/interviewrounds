import { describe, expect, it, vi } from 'vitest';
import type { HeadSample } from '../shared/types';
import { HeadSampler } from '../xr/head';
import { createHeadPort } from './headPort';

describe('head port', () => {
  it('samples_on_frames_with_wall_clock_times_and_flushes_on_stop', () => {
    const frames = new Set<(dt: number, now: number) => void>();
    let t = 1_700_000_000_000;
    const spoke: boolean[] = [];
    const port = createHeadPort({
      makeSampler: (send) => new HeadSampler({ send }),
      onFrame: (cb) => (frames.add(cb), () => frames.delete(cb)),
      headPose: () => ({ pos: { x: 0, y: 1.2, z: 0 }, yaw: 0, pitch: 0 }),
      targets: () => [{ id: 'p1', pos: { x: 0, y: 1.2, z: -1.4 } }],
      onUserSpeaking: (b) => spoke.push(b),
      now: () => t,
    });
    const sink = vi.fn<(s: HeadSample[]) => void>();
    port.setFloor('p1');
    port.start(sink);
    for (let i = 0; i < 30; i++) {
      t += 100;
      if (i === 15) port.setUserSpeaking(true);
      frames.forEach((cb) => cb(0.1, i * 100));
    }
    port.stop();
    expect(frames.size).toBe(0);
    expect(sink).toHaveBeenCalledTimes(1);
    const samples = sink.mock.calls[0]![0];
    expect(samples.length).toBeGreaterThanOrEqual(14); // 5 a second over 3 s
    expect(samples[0]!.t_ms).toBeGreaterThan(1_700_000_000_000);
    expect(samples[0]).toMatchObject({ target: 'p1', yaw: 0, pitch: 0, speaking: false });
    expect(samples.at(-1)!.speaking).toBe(true);
    expect(spoke).toEqual([true]);
  });
});
