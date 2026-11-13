// Frame rate choice for the immersive session. Quest Browser starts WebXR at 72 Hz; Meta's guidance is to raise the
// rate only with headroom and lower it when frames are missed. Two signals per frame:
// - CPU time (first system to end of render submit), which shows script and draw-call cost;
// - the interval between XR frames, which also shows GPU stalls: a frame the compositor could not take in time
//   arrives a whole period late.
// The governor stays idle until armed (call arm() once the room and the people are on screen, and again when the
// scene grows), so it never judges the light placement phase.

export type Rate = 72 | 90;

const WINDOW_MS = 5000;
/** Raise from 72 only when the CPU p95 is under this and almost no frame was late. */
const RAISE_CPU_MS = 9;
const RAISE_MAX_LATE = 0.01;
/** At 90 Hz, drop back when the CPU p95 is over this or too many frames were late. */
const LOWER_CPU_MS = 11;
const LOWER_MAX_LATE = 0.05;
/** A frame is late when its interval exceeds this many periods. */
const LATE_FACTOR = 1.5;
/** Hysteresis: after a drop, wait this long before trying 90 again; give up after this many drops. */
const RETRY_AFTER_MS = 30000;
const MAX_DROPS = 2;

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
}

export class FrameRateGovernor {
  rate: Rate = 72;
  private armed = false;
  private windowStart = 0;
  private cpu: number[] = [];
  private frames = 0;
  private late = 0;
  private drops = 0;
  private lastDropAt = -Infinity;
  private gaveUp = false;
  /** The last window's numbers, for logs. */
  last = { cpuP95: 0, lateShare: 0 };

  constructor(private readonly supported: readonly number[]) {}

  /** Start (or restart) measuring from now: the scene is complete. */
  arm(nowMs: number): void {
    this.armed = true;
    this.reset(nowMs);
  }

  disarm(): void {
    this.armed = false;
  }

  /** updateTargetFrameRate refused the raise: back to 72 for good. */
  refused(): void {
    this.rate = 72;
    this.gaveUp = true;
  }

  /** Feed one frame: CPU ms, the interval since the previous XR frame, and now. Returns a rate to request. */
  frame(cpuMs: number, intervalMs: number, nowMs: number): Rate | null {
    if (!this.armed) return null;
    this.cpu.push(cpuMs);
    this.frames++;
    if (intervalMs > (LATE_FACTOR * 1000) / this.rate) this.late++;
    if (nowMs - this.windowStart < WINDOW_MS) return null;
    const cpuP95 = p95(this.cpu);
    const lateShare = this.frames ? this.late / this.frames : 0;
    this.last = { cpuP95, lateShare };
    this.reset(nowMs);
    if (this.rate === 72) {
      const canTry = !this.gaveUp && this.supported.includes(90) && nowMs - this.lastDropAt >= RETRY_AFTER_MS;
      if (canTry && cpuP95 < RAISE_CPU_MS && lateShare < RAISE_MAX_LATE) {
        this.rate = 90;
        return 90;
      }
      return null;
    }
    if (cpuP95 > LOWER_CPU_MS || lateShare > LOWER_MAX_LATE) {
      this.rate = 72;
      this.drops++;
      this.lastDropAt = nowMs;
      if (this.drops >= MAX_DROPS) this.gaveUp = true;
      return 72;
    }
    return null;
  }

  describe(): string {
    const { cpuP95, lateShare } = this.last;
    return `${this.rate} Hz (CPU p95 ${cpuP95.toFixed(1)} ms, late frames ${(lateShare * 100).toFixed(1)}%${this.gaveUp ? ', 90 Hz given up' : ''})`;
  }

  private reset(nowMs: number): void {
    this.windowStart = nowMs;
    this.cpu = [];
    this.frames = 0;
    this.late = 0;
  }
}
