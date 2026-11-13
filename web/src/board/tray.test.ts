import { describe, expect, it } from 'vitest';
import { HLD_KIT } from './kits';
import { SHEET } from './model';
import { DeskPlacement } from '../xr/placement';
import { dominantFor, kitFor } from './tray';

describe('kitFor', () => {
  it('keeps the tray on the left and the bin on the right for a right-handed user', () => {
    expect(kitFor(HLD_KIT, 'right')).toBe(HLD_KIT);
  });

  it('mirrors the tray to the right and the bin to the left for a left-handed user', () => {
    const k = kitFor(HLD_KIT, 'left');
    for (const s of k.tray) {
      expect(s.x).toBeGreaterThanOrEqual(SHEET.w);
      expect(s.y).toBe(HLD_KIT.tray.find((t) => t.type === s.type)!.y);
    }
    expect(k.tray[0]).toMatchObject({ x: 66, w: 10 });
    expect(k.bin.x + k.bin.w).toBeLessThanOrEqual(0);
    expect(k.bin).toMatchObject({ x: -9, y: HLD_KIT.bin.y, w: 7, h: 7 });
    expect(k.view.x).toBeLessThanOrEqual(k.bin.x);
    expect(k.view.x + k.view.w).toBeGreaterThanOrEqual(k.tray[0]!.x + k.tray[0]!.w);
  });
});

describe('the dominant hand of a round', () => {
  const head = { pos: { x: 0, y: 1.2, z: 0 }, yaw: 0, pitch: -0.4 };
  /** Rests one index tip on the desk until the placement finishes. */
  function touchWith(hand: 'left' | 'right') {
    const p = new DeskPlacement(0);
    const tip = { x: hand === 'left' ? -0.1 : 0.1, y: 0.752, z: -0.45 };
    let s = p.update(0, head, []);
    for (let t = 0; t <= 2000 && s.state !== 'done'; t += 1000 / 72) {
      s = p.update(t, head, [{ hand, tracked: true, indexTip: tip, thumbTip: tip, tips: [tip], pinch: 0 }]);
    }
    return s.result!;
  }

  it('handedness_from_desk_touch', () => {
    const left = touchWith('left');
    expect(left.source).toBe('touch');
    expect(left.hand).toBe('left');
    // The touch wins over the 2D setting, for this round: the tray goes to the right of a left-hander's sheet.
    expect(dominantFor(left.hand, 'right')).toBe('left');
    const kit = kitFor(HLD_KIT, dominantFor(left.hand, 'right'));
    for (const s of kit.tray) expect(s.x).toBeGreaterThanOrEqual(SHEET.w);
    expect(dominantFor(touchWith('right').hand, 'left')).toBe('right');
    expect(kitFor(HLD_KIT, dominantFor(touchWith('right').hand, 'left'))).toBe(HLD_KIT);
  });

  it('without_a_touch_the_setting_decides_and_right_is_the_default', () => {
    // The no-desk fallback has no touching hand.
    const p = new DeskPlacement(0);
    const fallback = p.update(6000, head, []).result!;
    expect(fallback.hand).toBeUndefined();
    expect(dominantFor(fallback.hand, 'left')).toBe('left');
    expect(dominantFor(undefined, undefined)).toBe('right');
  });
});
