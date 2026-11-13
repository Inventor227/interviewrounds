// Scoring for the echo test. The agent reads a passage through the headset speakers. First the tester stays silent
// (anything heard is the agent's own voice coming back through the mic: false triggers), then the tester talks
// over the agent (barge-in: did it stop, and how fast). Pure: fed with transport events, mic and agent levels.
// One timeline: the silent part ends when her own words say "talk over me" (the cue in the server's passage), so
// a tester who obeys the cue is never counted as echo. Timers are only the fallback when no agent text arrives.

import type { VoiceMode } from '../shared/types';
import { levelSummary, percentile, type LevelSummary } from './stats';

/** The spoken cue in the passage (server/src/api/diag.rs ECHO_PASSAGE: "Now please talk over me"). */
export const CUE = /talk over me/i;
/** Without any agent text the silent part ends on this timer; with text but no cue, on SILENT_MAX_MS. */
export const SILENT_MS = 45000;
export const SILENT_MAX_MS = 75000;
/** Utterances first heard this close before the cue belong to the barge part (the tester reacting). */
export const CUE_GRACE_MS = 1500;
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
    /** What ended the silent part: her cue, or the fallback timer. */
    started_by: 'cue' | 'timer' | null;
    /** When the tester started talking, from the start of the barge part. */
    onset_ms: number | null;
    onset_source: 'mic' | 'transcript' | null;
    /** She stopped within a second of the tester's onset (a barge-in), or her audio went quiet after it. */
    agent_stopped: boolean;
    /** She stopped with nobody talking over her (end of the passage, a pause). */
    stopped_on_its_own: boolean;
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
  private readonly silentSegs = new Map<string, { text: string; final: boolean; at: number }>();
  private textSeen = false;
  private bargeBy: 'cue' | 'timer' | null = null;
  private readonly bargeSegs = new Map<string, string>();
  private interruptions = 0;
  private readonly silentMic: number[] = [];
  private readonly silentAgent: number[] = [];
  private readonly bargeMic: number[] = [];
  private onsetAt: number | null = null;
  private onsetSource: 'mic' | 'transcript' | null = null;
  private loudRun = 0;
  private readonly stops: number[] = [];
  private quietSince: number | null = null;
  private audioStopAt: number | null = null;
  private readonly timeline: [number, string, string][] = [];

  constructor(
    private readonly startAt: number,
    private readonly silentMs = SILENT_MS,
    private readonly bargeMs = BARGE_MS,
    private readonly silentMaxMs = SILENT_MAX_MS,
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
      // Every stop in the barge part is kept; the one that answers the tester is picked in results().
      if (this.phase === 'barge') this.stops.push(t);
    }
    this.tick(t);
  }

  /** Her words as they play (the segment text so far): the cue in them ends the silent part. */
  agentText(t: number, text = ''): void {
    this.speaking(t);
    this.textSeen = true;
    if (this.phase === 'silent' && CUE.test(text)) this.startBarge(t, 'cue');
    this.tick(t);
  }

  user(segmentId: string, text: string, final: boolean, t: number): void {
    this.log(t, final ? 'user.final' : 'user', text);
    if (this.phase === 'silent' || this.phase === 'waiting') {
      const prev = this.silentSegs.get(segmentId);
      this.silentSegs.set(segmentId, { text, final: final || !!prev?.final, at: prev?.at ?? t });
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
    if (this.phase === 'silent' && this.speechAt !== null && t - this.speechAt >= (this.textSeen ? this.silentMaxMs : this.silentMs)) {
      this.startBarge(t, 'timer');
    }
    if (this.phase === 'barge' && this.bargeAt !== null) {
      const stop = this.bargeStop();
      const stopped = stop !== null && t - stop >= 2000;
      if (t - this.bargeAt >= this.bargeMs || stopped) {
        this.phase = 'done';
        this.log(t, 'phase', 'done');
      }
    }
  }

  private startBarge(t: number, by: 'cue' | 'timer'): void {
    this.phase = 'barge';
    this.bargeAt = t;
    this.bargeBy = by;
    this.log(t, 'phase', `barge (${by})`);
    // Someone who starts talking right at the cue is the tester reacting, not echo.
    for (const [id, seg] of this.silentSegs) {
      if (seg.at < t - CUE_GRACE_MS) continue;
      this.silentSegs.delete(id);
      this.bargeSegs.set(id, seg.text);
      if (this.onsetAt === null || seg.at < this.onsetAt) {
        this.onsetAt = seg.at;
        this.onsetSource = 'transcript';
      }
    }
  }

  /** The stop that answers the tester: the first one from a second before the onset on (the transcript lags). */
  private bargeStop(): number | null {
    const onset = this.onsetAt;
    if (onset === null) return null;
    return this.stops.find((s) => s >= onset - 1000) ?? null;
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
    const stop = this.bargeStop();
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
        started_by: this.bargeBy,
        agent_stopped: stop !== null || this.audioStopAt !== null,
        stopped_on_its_own: this.stops.some((x) => x !== stop && (this.onsetAt === null || x < this.onsetAt - 1000)),
        stop_after_onset_ms: rel(stop),
        audio_stop_after_onset_ms: rel(this.audioStopAt),
        user_texts: [...this.bargeSegs.values()].slice(0, MAX_TEXTS).map((s) => s.slice(0, 80)),
        mic: levelSummary(this.bargeMic),
      },
      timeline: [...this.timeline],
    };
  }
}
