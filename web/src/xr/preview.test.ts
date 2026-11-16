import { describe, expect, it } from 'vitest';
import { PREVIEW_MAX_PIXELS, PREVIEW_MAX_RATIO, previewPixelRatio } from './preview';

const buffer = (dpr: number, w: number, h: number) => {
  const r = previewPixelRatio(dpr, w, h);
  return { r, px: Math.floor(w * r) * Math.floor(h * r) };
};

describe('previewPixelRatio', () => {
  it('keeps a desktop screen at its own ratio', () => {
    expect(previewPixelRatio(1, 928, 522)).toBe(1);
    expect(previewPixelRatio(1, 1600, 900)).toBe(1);
  });

  it('caps a phone (2.75 device pixels per CSS pixel) at 2 on its small stage', () => {
    const { r, px } = buffer(2.75, 380, 214);
    expect(r).toBe(PREVIEW_MAX_RATIO);
    expect(px).toBeLessThan(0.4e6); // 760 x 428, not 1045 x 588
  });

  it('keeps the hidden 960 x 540 room of the Ready step within the pixel budget on a phone', () => {
    // At the full ratio this buffer is 2640 x 1485 (3.9 million pixels, with MSAA) on a phone.
    for (const dpr of [2.625, 2.75, 3, 3.5, 4]) {
      const { px } = buffer(dpr, 960, 540);
      expect(px).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
    }
  });

  it('keeps a laptop with a sharp screen close to its look', () => {
    const { r, px } = buffer(2, 928, 522);
    expect(r).toBe(PREVIEW_MAX_RATIO); // the page's widest stage (928 x 522) keeps a 2x screen's full ratio
    expect(px).toBeLessThanOrEqual(PREVIEW_MAX_PIXELS);
  });

  it('never goes under 1 for a big stage, and never above the device ratio', () => {
    expect(previewPixelRatio(1, 2560, 1440)).toBe(1);
    expect(previewPixelRatio(0.8, 600, 400)).toBe(0.8);
    expect(previewPixelRatio(1.25, 300, 200)).toBe(1.25);
  });

  it('treats a missing or broken ratio or size as 1', () => {
    expect(previewPixelRatio(Number.NaN, 400, 300)).toBe(1);
    expect(previewPixelRatio(0, 400, 300)).toBe(1);
    expect(previewPixelRatio(2, 0, 0)).toBe(PREVIEW_MAX_RATIO);
  });
});
