// Blinks: a new blink every 2 to 6 s (uniform), each 180 ms long (fast close, short hold, slower open). The rate
// follows the conversation: an attentive listener blinks less, a speaker or someone thinking more. Gaze shifts and
// phrase starts can trigger an extra blink, and now and then a blink comes as a quick double, as people do.

import type { Rng } from './rng';

export const BLINK_MS = 180;
export const BLINK_GAP_MIN_MS = 2000;
export const BLINK_GAP_MAX_MS = 6000;

const CLOSE_MS = 55;
const HOLD_MS = 25;
const DOUBLE_CHANCE = 0.1;
const DOUBLE_GAP_MS = 70;
/** A triggered blink is skipped if one ended this recently (no blink storms). */
const REFRACTORY_MS = 400;

/** Gap range per conversation mode, ms: listeners blink less while they attend, speakers and thinkers more. */
export type BlinkPace = 'idle' | 'listening' | 'thinking' | 'speaking';
const PACE: Record<BlinkPace, [number, number]> = {
  idle: [BLINK_GAP_MIN_MS, BLINK_GAP_MAX_MS],
  listening: [2600, 6500],
  thinking: [1500, 4000],
  speaking: [1800, 4500],
};

/** Wait before the next spontaneous blink: uniform in the pace's range ([2000, 6000] ms by default). */
export function nextBlinkMs(rng: Rng, pace: BlinkPace = 'idle'): number {
  const [lo, hi] = PACE[pace];
  return lo + rng() * (hi - lo);
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
  private pace: BlinkPace = 'idle';

  constructor(private readonly rng: Rng) {
    this.wait = nextBlinkMs(rng);
  }

  /** Follows the conversation mode; a pending wait longer than the new range allows is cut down to it. */
  setPace(pace: BlinkPace): void {
    this.pace = pace;
    this.wait = Math.min(this.wait, PACE[pace][1]);
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
        this.wait = this.pendingDouble ? DOUBLE_GAP_MS : nextBlinkMs(this.rng, this.pace);
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
