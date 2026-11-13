import { describe, expect, it, vi } from 'vitest';
import { AnchorTracker, PlacementCancelled, PlacementLifecycle } from './lifecycle';
import type { DeskPose } from './placement';

const DESK: DeskPose = { origin: { x: 0, y: 0.74, z: -0.4 }, yaw: 0, deskY: 0.74, source: 'touch' };

function lifecycle() {
  const start = vi.fn();
  const reset = vi.fn();
  const l = new PlacementLifecycle({ start, reset });
  return { l, start, reset };
}

describe('PlacementLifecycle', () => {
  it('place_needs_a_session', async () => {
    const { l, start } = lifecycle();
    await expect(l.place()).rejects.toBeInstanceOf(PlacementCancelled);
    expect(start).not.toHaveBeenCalled();
  });

  it('place_is_explicit_and_shared_while_in_flight', async () => {
    const { l, start } = lifecycle();
    l.sessionStarted();
    expect(start).not.toHaveBeenCalled(); // no automatic placement
    const a = l.place();
    const b = l.place();
    expect(a).toBe(b);
    expect(start).toHaveBeenCalledTimes(1);
    l.finished(DESK);
    await expect(a).resolves.toEqual(DESK);
    // Already placed in this session: resolves at once, no new placement.
    await expect(l.place()).resolves.toEqual(DESK);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('session_end_mid_placement_rejects_and_resets', async () => {
    const { l, reset } = lifecycle();
    l.sessionStarted();
    const p = l.place();
    l.sessionEnded();
    await expect(p).rejects.toBeInstanceOf(PlacementCancelled);
    expect(l.desk).toBeNull();
    expect(reset).toHaveBeenCalled();
    // A late finish from the old session is ignored.
    l.finished(DESK);
    expect(l.desk).toBeNull();
  });

  it('a_new_session_forgets_the_old_desk', async () => {
    const { l, start } = lifecycle();
    l.sessionStarted();
    const p = l.place();
    l.finished(DESK);
    await p;
    l.sessionEnded();
    l.sessionStarted();
    expect(l.desk).toBeNull();
    const q = l.place();
    expect(start).toHaveBeenCalledTimes(2);
    l.finished({ ...DESK, deskY: 0.7 });
    await expect(q).resolves.toMatchObject({ deskY: 0.7 });
  });

  it('replace_starts_a_new_placement_in_the_same_session', async () => {
    const { l, start } = lifecycle();
    l.sessionStarted();
    const p = l.place();
    l.finished(DESK);
    await p;
    const q = l.replace();
    expect(start).toHaveBeenCalledTimes(2);
    l.finished({ ...DESK, deskY: 0.71 });
    await expect(q).resolves.toMatchObject({ deskY: 0.71 });
  });
});

describe('AnchorTracker', () => {
  const pose = { transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0, 0, 1]) } };

  it('applies_the_anchor_drift_and_deletes_old_anchors', () => {
    const apply = vi.fn();
    const t = new AnchorTracker(apply);
    const del = vi.fn();
    const gen = t.begin();
    t.adopt(gen, { anchorSpace: {} as XRSpace, delete: del }, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    t.update({ getPose: () => pose } as unknown as XRFrame, {} as XRReferenceSpace);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0][12]).toBeCloseTo(0.1, 6);
    t.clear();
    expect(del).toHaveBeenCalled();
  });

  it('a_late_anchor_from_an_older_placement_is_dropped', () => {
    const t = new AnchorTracker(vi.fn());
    const old = t.begin();
    t.begin();
    const del = vi.fn();
    t.adopt(old, { anchorSpace: {} as XRSpace, delete: del }, new Float32Array(16));
    expect(del).toHaveBeenCalled();
    expect(t.active).toBe(false);
  });

  it('a_dead_session_anchor_never_throws_per_frame', () => {
    const apply = vi.fn();
    const t = new AnchorTracker(apply);
    const gen = t.begin();
    t.adopt(gen, { anchorSpace: {} as XRSpace, delete: vi.fn() }, new Float32Array(16));
    const frame = {
      getPose: () => {
        throw new DOMException('different session', 'InvalidStateError');
      },
    } as unknown as XRFrame;
    expect(() => t.update(frame, {} as XRReferenceSpace)).not.toThrow();
    expect(t.active).toBe(false); // dropped after the first failure
    expect(() => t.update(frame, {} as XRReferenceSpace)).not.toThrow();
  });
});
