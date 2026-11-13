// Per-turn latency split, measured in the browser:
//   user final transcript → agent `thinking` → first agent text (first audible words).
// A finished split rides on the next `voice.state` message and shows in the dev overlay.

export interface LatencySplit {
  turn: number;
  /** When the user's final transcript arrived (epoch ms). */
  user_final_at_ms: number;
  /** Final transcript to `thinking`; null when the agent went straight to speaking. */
  to_thinking_ms: number | null;
  /** Final transcript to the first agent text. */
  to_first_text_ms: number;
}

const KEEP = 20;

export class LatencyTracker {
  /** Most recent splits, newest last. */
  readonly history: LatencySplit[] = [];
  private turns = 0;
  private pending: { turn: number; finalAt: number; thinkingAt: number | null } | null = null;
  private ready: LatencySplit | null = null;

  /** A user segment became final. A later final in the same pause moves the start. */
  userFinal(at: number): void {
    this.pending = { turn: this.pending?.turn ?? ++this.turns, finalAt: at, thinkingAt: null };
  }

  thinking(at: number): void {
    if (this.pending && this.pending.thinkingAt === null) this.pending.thinkingAt = at;
  }

  /** First agent text after a user turn completes the split. */
  agentText(at: number): LatencySplit | null {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    const split: LatencySplit = {
      turn: p.turn,
      user_final_at_ms: p.finalAt,
      to_thinking_ms: p.thinkingAt === null ? null : p.thinkingAt - p.finalAt,
      to_first_text_ms: at - p.finalAt,
    };
    this.ready = split;
    this.history.push(split);
    if (this.history.length > KEEP) this.history.shift();
    return split;
  }

  /** The finished split not yet sent, if any; it is handed out once. */
  take(): LatencySplit | null {
    const r = this.ready;
    this.ready = null;
    return r;
  }
}
