import { describe, expect, it } from 'vitest';
import { HLD_KIT } from './kits';
import { SHEET } from './model';
import { kitFor } from './tray';

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
