// The voice transport contract. One transport carries one panelist's voice: Fish Agents over
// WebRTC in production (fish.ts), or the typed-turn FakeTransport in development (fake.ts).
// Both emit the same events, so the panel and the round controller never know which one runs.

import type { VoiceMode } from '../shared/types';

/** Mic settings for the pre-start permission request; the Fish SDK captures with the same ones. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface UserTranscript {
  /** Groups the updates of one utterance; interim updates replace the text, they never append. */
  segmentId: string;
  /** Full text of the utterance so far. */
  text: string;
  final: boolean;
}

export interface AgentText {
  segmentId: string;
  /** New text since the last event of this segment (paced to playback). */
  delta: string;
  /** Segment text so far. */
  text: string;
}

export type VoiceErrorCode =
  | 'mic_denied'
  | 'no_mic'
  | 'mic_busy'
  | 'audio_blocked'
  | 'connect_failed'
  | 'session_expired'
  | 'no_credit'
  | 'llm_failed'
  | 'provider_error'
  | 'voice_lost'
  | 'unknown';

export class VoiceError extends Error {
  override readonly name = 'VoiceError';
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface TransportEvents {
  mode: (mode: VoiceMode) => void;
  userTranscript: (e: UserTranscript) => void;
  agentText: (e: AgentText) => void;
  ended: (e: { reason: string }) => void;
  error: (e: VoiceError) => void;
}
export type TransportEvent = keyof TransportEvents;

export interface VoiceTransport {
  readonly panelistId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves once the change has taken effect (the capture track is muted); never rejects. */
  setMicMuted(muted: boolean): void | Promise<void>;
  /** A marker turn (`[event: ...]`): the agent answers it out loud. */
  sendEvent(marker: string): void;
  /** A typed user turn (dev console). */
  sendText(text: string): void;
  /** The agent's audio for analysis only (lip sync). Never route it to the speakers. */
  outputStream(): MediaStream | null;
  on<K extends TransportEvent>(event: K, cb: TransportEvents[K]): () => void;
  /** Stops the agent mid-sentence (pause, barge-in). */
  interrupt?(): void;
  /** The user is busy (drawing on the board): keeps the voice service from re-engaging. */
  noteActivity?(): void;
  /** Retries agent playback blocked by autoplay rules. Call it from a user gesture. */
  startAudio?(): Promise<void>;
}

/** Options a transport factory gets besides the panelist. */
export interface TransportOptions {
  /** Swap-mode hand-over: the line the new panelist opens with. */
  openingLine?: string;
}

/** Small typed event emitter; a failing listener never breaks the others. */
export class Emitter<E extends { [K in keyof E]: (...args: never[]) => void }> {
  private readonly listeners = new Map<keyof E, Set<E[keyof E]>>();

  on<K extends keyof E>(event: K, cb: E[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as (...a: Parameters<E[K]>) => void)(...args);
      } catch (err) {
        console.error('listener failed', String(event), err);
      }
    }
  }
}

const MARKER = /^\[event: [a-z_]+\]$/;

/** True for a marker text such as `[event: start]`. */
export function isMarker(text: string): boolean {
  return MARKER.test(text.trim());
}
