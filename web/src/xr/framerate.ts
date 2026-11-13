// Frame rate choice for the immersive session. Quest Browser starts WebXR at 72 Hz. We move to 90 Hz only when the
// measured frame time (95th percentile over 5 s) stays under 9 ms, and fall back to 72 Hz for good if 90 Hz frames
// run over 11 ms (Meta WebXR frame rate guidance). Pure logic; world.ts feeds it and calls updateTargetFrameRate.

export type Rate = 72 | 90;

const WINDOW_MS = 5000;
const RAISE_UNDER_MS = 9;
const LOWER_OVER_MS = 11;

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
}

export class FrameRateGovernor {
  rate: Rate = 72;
  private samples: number[] = [];
  private windowStart: number | null = null;
  private gaveUp = false;

  constructor(private readonly supported: readonly number[]) {}

  /** Feed one frame's CPU time; returns a new rate when one should be requested. */
  frame(frameMs: number, nowMs: number): Rate | null {
    if (this.windowStart === null) this.windowStart = nowMs;
    this.samples.push(frameMs);
    if (nowMs - this.windowStart < WINDOW_MS) return null;
    const v = p95(this.samples);
    this.samples = [];
    this.windowStart = nowMs;
    if (this.rate === 72 && !this.gaveUp && this.supported.includes(90) && v < RAISE_UNDER_MS) {
      this.rate = 90;
      return 90;
    }
    if (this.rate === 90 && v > LOWER_OVER_MS) {
      this.rate = 72;
      this.gaveUp = true;
      return 72;
    }
    return null;
  }

  /** The last window's 95th percentile is not kept; this reports the state for logs. */
  describe(): string {
    return `${this.rate} Hz${this.gaveUp ? ' (90 Hz tried and dropped)' : ''}`;
  }
}
