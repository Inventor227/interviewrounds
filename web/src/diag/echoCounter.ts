// Scoring for the echo test. The agent reads a passage through the headset speakers. First the tester stays silent
// (anything heard is the agent's own voice coming back through the mic: false triggers), then the tester talks
// over the agent (barge-in: did it stop, and how fast). Pure: fed with transport events, mic and agent levels.

import type { VoiceMode } from '../shared/types';
import { levelSummary, percentile, type LevelSummary } from './stats';

export const SILENT_MS = 45000;
export const BARGE_MS = 15000;
/** The agent counts as silent after its level stays under this for QUIET_MS. */
export const AGENT_QUIET_DB = -50;
/** Longer than the pause between two sentences. */
export const QUIET_MS = 600;
/** Speech onset: the mic level over max(this, the silent part's p95 + ONSET_OVER_DB) for two samples in a row. */
export const ONSET_MIN_DB = -40;
export const ONSET_OVER_DB = 6;
const MAX_TEXTS = 10;
const MAX_TIMELINE = 150;

export type EchoPhase = 'waiting' | 'silent' | 'barge' | 'done';

export interface EchoResults {
  /** From start to the voice session connected, and to the agent first speaking. */
  connect_ms: number | null;
  first_speech_ms: number | null;
  silent: {
    ms: number;
    /** User utterances heard while the tester was silent (echo false triggers), and how many became final. */
    user_segments: number;
    user_finals: number;
    user_texts: string[];
    /** Times the agent stopped speaking during the silent part (cut off by what it heard). */
    agent_interruptions: number;
    mic: LevelSummary | null;
    agent: LevelSummary | null;
  };
  barge: {
    /** When the tester started talking, from the start of the barge part. */
    onset_ms: number | null;
    onset_source: 'mic' | 'transcript' | null;
    agent_stopped: boolean;
    /** From the tester's onset to the agent leaving the speaking state, and to its audio going quiet. */
    stop_after_onset_ms: number | null;
    audio_stop_after_onset_ms: number | null;
    user_texts: string[];
    mic: LevelSummary | null;
  };
  timeline: [number, string, string][];
}

export class EchoCounter {
  phase: EchoPhase = 'waiting';
  private connectedAt: number | null = null;
  private speechAt: number | null = null;
  private bargeAt: number | null = null;
  private mode_: VoiceMode = 'listening';
  private readonly silentSegs = new Map<string, { text: string; final: boolean }>();
  private readonly bargeSegs = new Map<string, string>();
  private interruptions = 0;
  private readonly silentMic: number[] = [];
  private readonly silentAgent: number[] = [];
  private readonly bargeMic: number[] = [];
  private onsetAt: number | null = null;
  private onsetSource: 'mic' | 'transcript' | null = null;
  private loudRun = 0;
  private stopAt: number | null = null;
  private quietSince: number | null = null;
  private audioStopAt: number | null = null;
  private readonly timeline: [number, string, string][] = [];

  constructor(
    private readonly startAt: number,
    private readonly silentMs = SILENT_MS,
    private readonly bargeMs = BARGE_MS,
  ) {}

  private log(t: number, kind: string, detail = ''): void {
    if (this.timeline.length < MAX_TIMELINE) this.timeline.push([Math.round(t - this.startAt), kind, detail.slice(0, 80)]);
  }

  /** Seconds left in the current part, for the page. */
  remainingMs(t: number): number {
    if (this.phase === 'silent' && this.speechAt !== null) return Math.max(0, this.speechAt + this.silentMs - t);
    if (this.phase === 'barge' && this.bargeAt !== null) return Math.max(0, this.bargeAt + this.bargeMs - t);
    return 0;
  }

  connected(t: number): void {
    this.connectedAt ??= t;
    this.log(t, 'connected');
  }

  mode(m: VoiceMode, t: number): void {
    const was = this.mode_;
    this.mode_ = m;
    this.log(t, 'mode', m);
    if (m === 'speaking') this.speaking(t);
    if (was === 'speaking' && m !== 'speaking') {
      if (this.phase === 'silent') this.interruptions++;
      // The passage runs on until someone talks over it: a stop in the barge part is the barge-in (it may come
      // before the first transcript, so it does not wait for the onset).
      if (this.phase === 'barge' && this.stopAt === null) this.stopAt = t;
    }
    this.tick(t);
  }

  agentText(t: number): void {
    this.speaking(t);
    this.tick(t);
  }

  user(segmentId: string, text: string, final: boolean, t: number): void {
    this.log(t, final ? 'user.final' : 'user', text);
    if (this.phase === 'silent' || this.phase === 'waiting') {
      const prev = this.silentSegs.get(segmentId);
      this.silentSegs.set(segmentId, { text, final: final || !!prev?.final });
    } else if (this.phase === 'barge') {
      this.bargeSegs.set(segmentId, text);
      if (this.onsetAt === null) {
        this.onsetAt = t;
        this.onsetSource = 'transcript';
      }
    }
    this.tick(t);
  }

  /** Level of the session's own mic capture (dBFS). */
  micLevel(db: number, t: number): void {
    if (this.phase === 'silent') this.silentMic.push(db);
    else if (this.phase === 'barge') {
      this.bargeMic.push(db);
      if (this.onsetAt === null) {
        const floor = this.silentMic.length ? percentile(this.silentMic, 95) + ONSET_OVER_DB : ONSET_MIN_DB;
        if (db > Math.max(ONSET_MIN_DB, floor)) {
          this.loudRun++;
          if (this.loudRun >= 2) {
            this.onsetAt = t;
            this.onsetSource = 'mic';
            this.log(t, 'onset', `${db} dB`);
          }
        } else this.loudRun = 0;
      }
    }
    this.tick(t);
  }

  /** Level of the agent's audio (dBFS). */
  agentLevel(db: number, t: number): void {
    if (this.phase === 'silent') this.silentAgent.push(db);
    if (this.phase === 'barge' && this.onsetAt !== null && this.audioStopAt === null) {
      if (db < AGENT_QUIET_DB) {
        this.quietSince ??= t;
        if (t - this.quietSince >= QUIET_MS) {
          this.audioStopAt = this.quietSince;
          this.log(t, 'agent.quiet');
        }
      } else this.quietSince = null;
    }
    this.tick(t);
  }

  tick(t: number): void {
    if (this.phase === 'silent' && this.speechAt !== null && t - this.speechAt >= this.silentMs) {
      this.phase = 'barge';
      this.bargeAt = t;
      this.log(t, 'phase', 'barge');
    }
    if (this.phase === 'barge' && this.bargeAt !== null) {
      const stopped = this.stopAt !== null && t - this.stopAt >= 2000;
      if (t - this.bargeAt >= this.bargeMs || stopped) {
        this.phase = 'done';
        this.log(t, 'phase', 'done');
      }
    }
  }

  private speaking(t: number): void {
    if (this.phase !== 'waiting') return;
    this.speechAt = t;
    this.phase = 'silent';
    this.log(t, 'phase', 'silent');
  }

  results(t: number): EchoResults {
    const segs = [...this.silentSegs.values()];
    const silentEnd = this.bargeAt ?? t;
    const rel = (x: number | null) => (x === null || this.onsetAt === null ? null : Math.round(x - this.onsetAt));
    return {
      connect_ms: this.connectedAt === null ? null : Math.round(this.connectedAt - this.startAt),
      first_speech_ms: this.speechAt === null ? null : Math.round(this.speechAt - this.startAt),
      silent: {
        ms: this.speechAt === null ? 0 : Math.round(silentEnd - this.speechAt),
        user_segments: segs.length,
        user_finals: segs.filter((s) => s.final).length,
        user_texts: segs.slice(0, MAX_TEXTS).map((s) => s.text.slice(0, 80)),
        agent_interruptions: this.interruptions,
        mic: levelSummary(this.silentMic),
        agent: levelSummary(this.silentAgent),
      },
      barge: {
        onset_ms: this.onsetAt === null || this.bargeAt === null ? null : Math.round(this.onsetAt - this.bargeAt),
        onset_source: this.onsetSource,
        agent_stopped: this.stopAt !== null || this.audioStopAt !== null,
        stop_after_onset_ms: rel(this.stopAt),
        audio_stop_after_onset_ms: rel(this.audioStopAt),
        user_texts: [...this.bargeSegs.values()].slice(0, MAX_TEXTS).map((s) => s.slice(0, 80)),
        mic: levelSummary(this.bargeMic),
      },
      timeline: [...this.timeline],
    };
  }
}
