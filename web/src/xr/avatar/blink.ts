// Blinks: a new blink every 2 to 6 s (uniform), each 140 ms long (fast close, short hold, slower open). Gaze shifts
// can trigger an extra blink, and now and then a blink comes as a quick double, as people do in conversation.

import type { Rng } from './rng';

export const BLINK_MS = 140;
export const BLINK_GAP_MIN_MS = 2000;
export const BLINK_GAP_MAX_MS = 6000;

const CLOSE_MS = 50;
const HOLD_MS = 20;
const DOUBLE_CHANCE = 0.1;
const DOUBLE_GAP_MS = 70;
/** A triggered blink is skipped if one ended this recently (no blink storms). */
const REFRACTORY_MS = 400;

/** Wait before the next spontaneous blink: uniform in [2000, 6000] ms. */
export function nextBlinkMs(rng: Rng): number {
  return BLINK_GAP_MIN_MS + rng() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS);
}

const easeIn = (u: number) => u * u;
const easeOut = (u: number) => 1 - (1 - u) * (1 - u);

/** Lid closure 0..1 at `ms` into a blink. */
export function blinkCurve(ms: number): number {
  if (ms <= 0 || ms >= BLINK_MS) return 0;
  if (ms < CLOSE_MS) return easeIn(ms / CLOSE_MS);
  if (ms < CLOSE_MS + HOLD_MS) return 1;
  const open = BLINK_MS - CLOSE_MS - HOLD_MS;
  return 1 - easeOut((ms - CLOSE_MS - HOLD_MS) / open);
}

export class Blinker {
  private wait: number;
  /** ms into the current blink, or -1 when the eyes are open. */
  private t = -1;
  private sinceEnd = Infinity;
  private pendingDouble = false;

  constructor(private readonly rng: Rng) {
    this.wait = nextBlinkMs(rng);
  }

  /** Blink now (for gaze shifts), unless a blink is running or just ended. */
  trigger(): void {
    if (this.t >= 0 || this.sinceEnd < REFRACTORY_MS) return;
    this.start();
  }

  /** Advances by dtMs and returns lid closure 0..1. */
  update(dtMs: number): number {
    if (this.t >= 0) {
      this.t += dtMs;
      if (this.t >= BLINK_MS) {
        this.t = -1;
        this.sinceEnd = 0;
        this.wait = this.pendingDouble ? DOUBLE_GAP_MS : nextBlinkMs(this.rng);
        this.pendingDouble = false;
        return 0;
      }
      return blinkCurve(this.t);
    }
    this.sinceEnd += dtMs;
    this.wait -= dtMs;
    if (this.wait <= 0) {
      const wasDouble = this.sinceEnd <= DOUBLE_GAP_MS + dtMs;
      this.start();
      if (!wasDouble) this.pendingDouble = this.rng() < DOUBLE_CHANCE;
      return blinkCurve(this.t);
    }
    return 0;
  }

  private start(): void {
    this.t = 0;
  }
}
