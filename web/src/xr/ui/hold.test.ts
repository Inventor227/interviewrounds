import { describe, expect, it } from 'vitest';
import { HoldToConfirm } from './hold';

describe('HoldToConfirm', () => {
  it('fires_on_release_after_the_ring_fills', () => {
    const h = new HoldToConfirm(1000);
    h.down(0);
    expect(h.progress(500)).toBeCloseTo(0.5, 6);
    expect(h.progress(1200)).toBe(1);
    // A finger still resting on the button does not end the round by itself.
    expect(h.fired).toBe(false);
    expect(h.up(1300)).toBe(true);
  });

  it('releasing_early_cancels', () => {
    const h = new HoldToConfirm(1000);
    h.down(0);
    expect(h.up(600)).toBe(false);
    expect(h.progress(1500)).toBe(0);
  });

  it('fires_once', () => {
    const h = new HoldToConfirm(1000);
    h.down(0);
    expect(h.up(1100)).toBe(true);
    expect(h.up(1200)).toBe(false);
  });
});
