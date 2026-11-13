// Per-turn latency split, measured in the browser:
//   user final transcript → agent `thinking` → first agent text (first audible words).
// A finished split rides on the next `voice.state` message and shows in the dev overlay.

export interface LatencySplit {
  turn: number;
  /** When the user's final transcript arrived (epoch ms). */
  user_final_at_ms: number;
  /**
   * Final transcript to `thinking`; negative when the voice service started thinking before the
   * final transcript arrived (end of turn can precede it); null when no thinking was seen.
   */
  to_thinking_ms: number | null;
  /** Final transcript to the first agent text. */
  to_first_text_ms: number;
}

const KEEP = 20;
/** A `thinking` this close before the final transcript belongs to the same turn. */
const EARLY_THINKING_MS = 3000;

export class LatencyTracker {
  /** Most recent splits, newest last. */
  readonly history: LatencySplit[] = [];
  private turns = 0;
  private pending: { turn: number; finalAt: number; thinkingAt: number | null; staleSegment: string | null } | null =
    null;
  private earlyThinking: number | null = null;
  private ready: LatencySplit | null = null;

  /**
   * A user segment became final. A later final in the same pause moves the start.
   * `agentSegment` is the agent segment still playing then (a barge-in): its trailing text does
   * not count as the reply.
   */
  userFinal(at: number, agentSegment: string | null = null): void {
    const early = this.earlyThinking !== null && at - this.earlyThinking <= EARLY_THINKING_MS ? this.earlyThinking : null;
    this.earlyThinking = null;
    this.pending = {
      turn: this.pending?.turn ?? ++this.turns,
      finalAt: at,
      thinkingAt: this.pending?.thinkingAt ?? early,
      staleSegment: agentSegment,
    };
  }

  thinking(at: number): void {
    if (!this.pending) this.earlyThinking = at;
    else if (this.pending.thinkingAt === null) this.pending.thinkingAt = at;
  }

  /** First agent text of a new segment after a user turn completes the split. */
  agentText(at: number, segmentId: string | null = null): LatencySplit | null {
    const p = this.pending;
    if (!p) {
      this.earlyThinking = null;
      return null;
    }
    if (segmentId !== null && segmentId === p.staleSegment) return null;
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
