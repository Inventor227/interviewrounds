// What the round controller needs from the other parts of the app. The XR room, the avatar
// runtime, the board and the head sampler implement these; tests use small fakes.

import type { Api } from '../net/api';
import type { CloseInfo, SocketStatus } from '../net/ws';
import type {
  ClientMsgMap,
  ClientMsgType,
  CreateSessionRes,
  HeadSample,
  HeadsetCard,
  Report,
  RoundStatePayload,
  ServerMsgMap,
  ServerMsgType,
} from '../shared/types';
import type { NoticeKind } from './notices';

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

/**
 * Buttons and gestures on the in-headset UI (round bar, status card, summary card). `hear` is the
 * "Tap to hear your interviewer" action shown when agent audio seems blocked. Every action is a
 * user gesture, so the controller also retries blocked audio on each one.
 */
export type UiAction = 'mute' | 'unmute' | 'pause' | 'resume' | 'end' | 'hear' | 'retry' | 'report' | 'history' | 'stay' | 'skip';

/** XRSession visibility: the system menu covers the room (`visible-blurred`) or the headset is off (`hidden`). */
export type XRVisibilityLike = 'visible' | 'visible-blurred' | 'hidden';

/** Why a round was paused (`ui.event {kind: "pause", reason}`). `voice_lost` is the room's own pause while it gets a new voice. */
export type PauseReason = 'user' | 'blurred' | 'hidden' | 'headset_removed' | 'voice_lost';

export interface SeatPoseLike {
  position: { x: number; y: number; z: number };
  yaw: number;
}

/** The XR app (room, placement, round UI). */
export interface XRPort {
  /**
   * Loads the room (code, world, renderer) and this round's people without requesting an XR
   * session, so enter() has nothing left to load. Called by prepare(), in the mic tap, with the
   * session it just got.
   */
  preload?(session: CreateSessionRes): Promise<void>;
  /**
   * Enters the immersive session. Needs the user activation of the Enter tap: call requestSession
   * first. Must reject when requestSession rejects (lost activation, refused), so the session page
   * can offer another tap instead of starting the voices on the 2D page.
   */
  enter(): Promise<void>;
  /**
   * Frees what preload() made (render loop, renderer, WebGL context, DOM), also when preload() is
   * still running. Called by RoundController.dispose(), e.g. when a prepared round is dropped
   * before Enter. The real room maps it to its destroy().
   */
  dispose?(): void;
  /** Resolves once the desk is placed (dwell or fallback). */
  place(): Promise<void>;
  /** False when no headset session is running (it ended, or was never entered). Absent: unknown. */
  inSession?(): boolean;
  /**
   * Plays the start chime (the desk is down, the round begins) and resolves when it is over. The
   * controller opens the mic and asks for the greeting only after that.
   */
  startCue?(): Promise<void>;
  exit?(): void;
  /** Any pinch in the room (a user gesture): the controller retries blocked audio on it. */
  onGesture?(cb: () => void): () => void;
  /** The headset session's visibility changed (system menu, headset off, back again). */
  onVisibility?(cb: (v: XRVisibilityLike) => void): () => void;
  /** The headset session ended; `byApp` when exit() asked for it. */
  onSessionEnd?(cb: (e: { byApp: boolean }) => void): () => void;
  /** The pause and resume tones. */
  cue?(name: 'pause' | 'resume'): void;
  /**
   * First round with a board on this device: teaches the one gesture by doing (draw a box), after
   * the desk is placed and before the round starts. Resolves `done` when the user made a box,
   * `skipped` when they pinched Skip, `none` when there is nothing to teach (no board, already
   * done, the preview). The round starts only after it resolves.
   */
  onboard?(): Promise<'done' | 'skipped' | 'none'>;
  ui: {
    setRoundState(s: RoundStatePayload & { controller: ControllerState }): void;
    showSummary(report: Report): void;
    /** The quick card a few seconds after the round: one line, the top strength and the top fix. */
    showCard?(card: HeadsetCard, opts?: { pending?: boolean }): void;
    setStatus(text: string | null, progress?: number): void;
    /** A designed card for an interruption (session/notices.ts); null takes the card down. */
    setNotice?(kind: NoticeKind | null): void;
    /**
     * The round is paused (or runs again): while paused the captions are cleared, no cue plays
     * and nothing on the board reaches the Scribe.
     */
    setPaused?(paused: boolean): void;
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
  /**
   * The round is ending (the user's End, the interviewer's own close, or the server's): the last
   * moment the sheet is what the round saw. The board sends its picture for the report now, while
   * the server still takes it.
   */
  roundEnding?(): void;
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
  /** Resolves with the first frame the server sends on this socket (it has taken the hello). */
  heard?(): Promise<void>;
  send<T extends ClientMsgType>(t: T, d: ClientMsgMap[T]): void;
  on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T]) => void): () => void;
  onStatus?(cb: (s: SocketStatus) => void): () => void;
  /** The server closed for good (bad token, unknown or ended session). */
  onTerminal?(cb: (info: CloseInfo) => void): () => void;
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

export type ApiPort = Pick<Api, 'createSession' | 'retry' | 'resumeSession' | 'joinPanelist' | 'endSession' | 'report'> & Partial<Pick<Api, 'onboardingDone'>>;
