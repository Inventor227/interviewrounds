// Hold to confirm (End): the ring fills over the hold time, and the action fires when the finger lifts after the
// ring is full. A finger that comes to rest on the button never ends the round by itself, and lifting early cancels.

export class HoldToConfirm {
  private start: number | null = null;
  private done = false;

  constructor(private readonly holdMs: number) {}

  down(nowMs: number): void {
    this.start = nowMs;
    this.done = false;
  }

  /** 0..1 while held, 0 otherwise. */
  progress(nowMs: number): number {
    if (this.start === null) return 0;
    return Math.min(1, Math.max(0, (nowMs - this.start) / this.holdMs));
  }

  /** Release (pointer up or leave). Returns true exactly once, when the ring was full. */
  up(nowMs: number): boolean {
    if (this.start === null) return false;
    const full = this.progress(nowMs) >= 1 && !this.done;
    this.start = null;
    if (full) this.done = true;
    return full;
  }

  get fired(): boolean {
    return this.done;
  }

  get holding(): boolean {
    return this.start !== null;
  }
}
