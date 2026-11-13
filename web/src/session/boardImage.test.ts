import { describe, expect, it, vi } from 'vitest';
import { boardPng, uploadBoard, type CanvasLike } from './boardImage';

/** A canvas whose PNG weighs one byte per pixel. */
const canvas = (width: number, height: number): CanvasLike => ({
  width,
  height,
  toBlob: (cb) => cb(new Blob([new Uint8Array(width * height)], { type: 'image/png' })),
});
const shrink = vi.fn((_src: CanvasLike, w: number, h: number) => canvas(w, h));

describe('board image', () => {
  it('a_board_that_fits_goes_as_it_is', async () => {
    const blob = await boardPng(canvas(1024, 640), 2 * 1024 * 1024, shrink);
    expect(blob!.size).toBe(1024 * 640);
    expect(blob!.type).toBe('image/png');
  });

  it('a_board_over_2_mb_is_halved_until_it_fits', async () => {
    shrink.mockClear();
    const blob = await boardPng(canvas(2048, 1280), 2 * 1024 * 1024, shrink);
    expect(blob!.size).toBe(1024 * 640);
    expect(shrink).toHaveBeenCalledTimes(1);
    // Nothing fits: give up instead of sending a stamp.
    expect(await boardPng(canvas(2048, 1280), 10, shrink)).toBeNull();
  });

  it('upload_never_rejects_and_says_whether_the_server_took_it', async () => {
    const ok = vi.fn(async () => undefined);
    expect(await uploadBoard(canvas(640, 400), ok, shrink)).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(await uploadBoard(canvas(640, 400), async () => Promise.reject(new Error('409')), shrink)).toBe(false);
    const broken: CanvasLike = { width: 10, height: 10, toBlob: (cb) => cb(null) };
    expect(await uploadBoard(broken, ok, shrink)).toBe(false);
  });
});
