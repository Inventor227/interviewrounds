// What the round controller hands the in-headset UI, and what the UI hands back.

import type { SessionStatus } from '../../shared/types';

export type RoundAction = 'mute' | 'unmute' | 'pause' | 'resume' | 'end' | 'hear' | 'retry' | 'report' | 'captions';

export interface RoundUIState {
  status: SessionStatus;
  /** Seconds into the round; the bar keeps counting locally while status is 'live'. */
  elapsed_s: number;
  /** Planned length in seconds; the timer turns amber at 80%. 0 hides it. */
  total_s: number;
  muted: boolean;
  /** Captions strip on or off (the setting). */
  captions?: boolean;
  /** The current question and its requirements, for the brief card. */
  brief?: { question: string; lines: string[] } | null;
}

export interface SummaryView {
  /** Verdict chip; null in meeting mode or with too little signal. */
  verdict: { label: string; tone: 'good' | 'mid' | 'low'; provisional?: boolean } | null;
  /** Shown when there is no verdict, e.g. "Not enough signal yet". */
  note?: string;
  /** Up to 4 bars, scores 1..4 (null = not observed). */
  bars: { name: string; score: number | null }[];
  strength: string | null;
  fix: string | null;
  /** Whether a retry of the weakest answer is offered. */
  canRetry: boolean;
}

export type StatusStage = 'placing' | 'connecting' | 'metrics' | 'scoring' | 'done' | 'paused' | 'hear' | 'error';
