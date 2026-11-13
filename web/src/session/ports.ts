// What the round controller needs from the other parts of the app. The XR room, the avatar
// runtime, the board and the head sampler implement these; tests use small fakes.

import type { Api } from '../net/api';
import type { SocketStatus } from '../net/ws';
import type {
  ClientMsgMap,
  ClientMsgType,
  HeadSample,
  Report,
  RoundStatePayload,
  ServerMsgMap,
  ServerMsgType,
} from '../shared/types';

export type ControllerState =
  | 'idle'
  | 'placing'
  | 'greeting'
  | 'live'
  | 'paused'
  | 'ending'
  | 'scoring'
  | 'summary'
  | 'failed';

/** Buttons and gestures on the in-headset UI (round bar, summary card). */
export type UiAction = 'mute' | 'unmute' | 'pause' | 'resume' | 'end' | 'retry' | 'report';

export interface SeatPoseLike {
  position: { x: number; y: number; z: number };
  yaw: number;
}

/** The XR app (room, placement, round UI). */
export interface XRPort {
  /** Enters the immersive session. Needs the user activation of the Start click. */
  enter(): Promise<void>;
  /** Resolves once the desk is placed (dwell or fallback). */
  place(): Promise<void>;
  exit?(): void;
  ui: {
    setRoundState(s: RoundStatePayload & { controller: ControllerState }): void;
    showSummary(report: Report): void;
    setStatus(text: string | null, progress?: number): void;
    onAction(cb: (action: UiAction) => void): () => void;
  };
  room: { seatPoses(): SeatPoseLike[] };
}

export type AvatarMode = 'idle' | 'listening' | 'thinking' | 'speaking';

/** One avatar in the room. */
export interface AvatarPort {
  setMode(mode: AvatarMode): void;
  /** The agent's audio stream, read by an analyser only. */
  attachVoice(stream: MediaStream): void;
}

/** The board: the controller only needs to know the user is working on it. */
export interface BoardPort {
  onActivity(cb: () => void): () => void;
}

/** 5 Hz head samples, batched; the controller forwards them to the socket. */
export interface HeadSamplerPort {
  start(sink: (samples: HeadSample[]) => void): void;
  stop(): void;
  setUserSpeaking(speaking: boolean): void;
  setFloor(panelistId: string): void;
}

/** The parts of SessionSocket the controller uses. */
export interface SocketPort {
  connect(): Promise<void>;
  send<T extends ClientMsgType>(t: T, d: ClientMsgMap[T]): void;
  on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T]) => void): () => void;
  onStatus?(cb: (s: SocketStatus) => void): () => void;
  close(): void;
}

/** Mic and audio unlock, done inside the Start click. */
export interface MediaPort {
  /** getUserMedia with the echo-safe constraints. Rejects with the browser's error. */
  getMic(): Promise<MediaStream>;
  /** AudioContext.resume() for the shared context. */
  resumeAudio(): Promise<void>;
}

/** Visibility of the page (hidden when the headset comes off or the tab changes). */
export interface VisibilityPort {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
  removeEventListener(type: 'visibilitychange', cb: () => void): void;
}

export type ApiPort = Pick<Api, 'createSession' | 'joinPanelist' | 'endSession' | 'report'>;
