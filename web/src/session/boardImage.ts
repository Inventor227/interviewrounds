// The sheet as a picture for the report: when the round ends, the board's canvas goes to the
// server as a PNG (at most 2 MB and 4096 px a side, docs/protocol.md). Fire and forget: the
// scorecard never waits for it, and a failure only means the report shows the board as text.

import { BOARD_IMAGE_MAX_BYTES } from '../net/api';

export interface CanvasLike {
  width: number;
  height: number;
  toBlob(cb: (b: Blob | null) => void, type?: string): void;
}

/** Makes a smaller copy of a canvas (the browser's 2D canvas by default). */
export type Shrink = (src: CanvasLike, width: number, height: number) => CanvasLike | null;

const MAX_SIDE = 4096;
const MIN_WIDTH = 256;

const defaultShrink: Shrink = (src, width, height) => {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(src as unknown as CanvasImageSource, 0, 0, width, height);
  return c;
};

const png = (c: CanvasLike) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'));

/** The canvas as a PNG within the size limits, halving it until it fits; null when that is not possible. */
export async function boardPng(canvas: CanvasLike, maxBytes: number = BOARD_IMAGE_MAX_BYTES, shrink: Shrink = defaultShrink): Promise<Blob | null> {
  let c: CanvasLike | null = canvas;
  const side = Math.max(canvas.width, canvas.height);
  if (side > MAX_SIDE) {
    const k = MAX_SIDE / side;
    c = shrink(canvas, Math.floor(canvas.width * k), Math.floor(canvas.height * k));
  }
  while (c) {
    const blob = await png(c);
    if (!blob) return null;
    if (blob.size <= maxBytes) return blob;
    if (c.width / 2 < MIN_WIDTH) return null;
    c = shrink(c, Math.floor(c.width / 2), Math.floor(c.height / 2));
  }
  return null;
}

/** Uploads the board picture; never rejects. Resolves true when the server took it. */
export async function uploadBoard(canvas: CanvasLike, upload: (png: Blob) => Promise<void>, shrink?: Shrink): Promise<boolean> {
  try {
    const blob = await boardPng(canvas, BOARD_IMAGE_MAX_BYTES, shrink);
    if (!blob) return false;
    await upload(blob);
    return true;
  } catch {
    return false;
  }
}
