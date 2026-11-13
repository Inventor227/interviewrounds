// RoundController: the client-side state machine of one round.
//
//   idle → placing → greeting → live ⇄ paused → ending → scoring → summary
//
// It ties together the session socket, the panel of voice transports, the XR app, the avatars,
// the head sampler and the board, and owns the browser's side of the conversation rules:
// - Two taps: prepare() in the mic tap (mic → AudioContext.resume() → create, retry or resume the
//   session → preload the room), then enter() in the Enter tap (enter XR as the first await →
//   desk placement → voices up → `[event: start]`). start() runs both, for tests and the preview.
// - `[event: silence_check]` once per silence: nobody speaking and no board activity for the
//   round's silence_wait_seconds.
// - `[event: long_answer]` once per candidate turn (segments with gaps under 1.2 s merge into
//   one turn) that runs past interrupt_after_seconds; interviews only, never over the agent.
// - `[event: time_check]` when round.state says time_check_due (or, from servers that do not send
//   it, when the next phase starts on time).
// - `transcript.mark` once per final user segment; `voice.state` on every mode change, carrying
//   the latest finished latency split.
// - Auto-pause when the page is hidden (headset off).
// - Every await in the start path re-checks the state, so an end, pause or dispose that lands
//   meanwhile never leaves a voice session running or greets into an ended round.
// - A greeting watchdog offers "Tap to hear your interviewer" when the agent stays silent (autoplay
//   blocked); every round bar tap and every pinch in the room also retries agent playback.
// - The voices connect while the user places the desk (muted until then), so the greeting starts
//   as soon as the desk is down.
// - `voice.spoken` once per reply with the first words as they played: the server keeps a reply,
//   and runs its actions, only once it is known to have played.
// - After the round: the status card with progress, the quick card as soon as the server has it,
//   then the full summary.

import type { ApiError } from '../net/api';
import {
  VOICE_MARKERS,
  type ClientMsgMap,
  type CreateSessionReq,
  type CreateSessionRes,
  type EndReason,
  type HeadsetCard,
  type Panelist,
  type RoundStatePayload,
  type VoiceChoice,
  type VoiceMode,
} from '../shared/types';
import { PanelController } from '../voice/panel';
import {
  Emitter,
  isMarker,
  VoiceError,
  type AgentText,
  type TransportOptions,
  type UserTranscript,
  type VoiceTransport,
} from '../voice/transport';
import { LatencyTracker, type LatencySplit } from './latency';
import type { StageTimings } from './timings';
import type {
  ApiPort,
  AvatarPort,
  BoardPort,
  ControllerState,
  HeadSamplerPort,
  MediaPort,
  SocketPort,
  UiAction,
  VisibilityPort,
  XRPort,
} from './ports';

/** Not part of RoundPublic yet; the server keeps them. Defaults match the round content. */
export interface RoundTiming {
  silenceWaitSeconds: number;
  interruptAfterSeconds: number;
}
export const DEFAULT_TIMING: RoundTiming = { silenceWaitSeconds: 20, interruptAfterSeconds: 120 };

/** Segments closer than this belong to the same candidate turn. */
export const TURN_GAP_MS = 1200;
/** Longest wait for the goodbye line before the round is closed anyway. */
export const ENDING_GRACE_MS = 15_000;
/** Longest wait for the outgoing panelist to finish its sentence before a hand-over. */
export const HANDOFF_WAIT_MS = 5000;
/** No agent speech this long after `[event: start]` → offer "Tap to hear your interviewer". */
export const GREETING_WATCHDOG_MS = 8000;
/** A user segment with no update for this long is treated as over (it never finalized). */
export const USER_SEGMENT_STALE_MS = 10_000;
/** Reconnecting for longer than this shows a status line and a typed error. */
export const RECONNECT_WARN_MS = 8000;
/** `voice.spoken` goes out once this much of a reply has played (or when a shorter reply ends). */
export const SPOKEN_MIN_CHARS = 24;
/** At most this much of the reply is reported. */
export const SPOKEN_MAX_CHARS = 60;
/** The mic stays closed this long at most around a typed long-answer marker. */
export const LONG_ANSWER_MUTE_MS = 2500;
/** After the mute for a long-answer marker took effect, wait this long before sending it. */
export const LONG_ANSWER_SETTLE_MS = 600;
/** Longest wait for the mic mute itself before the marker goes out anyway. */
const MUTE_WAIT_MS = 1500;
/** Once the server has closed the round, the closing line may play on for at most this long. */
export const GOODBYE_CAP_MS = 6000;
/** The interviewer closed the round and is already quiet: finish after this short grace. */
const QUIET_CLOSE_MS = 1000;
/** A voice token this close to its deadline is not joined; the session is made again instead. */
export const TOKEN_MARGIN_MS = 5000;
/** GET /report is tried again this many times, this far apart, before the fallback card. */
export const REPORT_RETRIES = 3;
export const REPORT_RETRY_MS = 2000;
/** Longest wait for the server's first frame after hello before the start marker goes out. */
const HELLO_WAIT_MS = 2000;
/** Pinches retry blocked audio at most this often. */
const GESTURE_UNLOCK_MS = 1000;
/** Board activity reaches the voice service at most this often. */
const ACTIVITY_THROTTLE_MS = 1000;
/** A phase change counts as "on time" when the old phase had at most this much left. */
const PHASE_TIME_SLACK_S = 5;

export type SessionErrorCode =
  | 'xr_enter_failed'
  /** The room (XR world) could not be loaded during prepare(). */
  | 'room_load_failed'
  /** enter() was called before prepare() finished. */
  | 'not_prepared'
  | 'placement_failed'
  | 'already_started'
  /** The room socket could not connect, or has been reconnecting for a while. */
  | 'socket_failed'
  /** The server closed the room socket for good (bad token, unknown or ended session). */
  | 'socket_terminal'
  /** The server sent an `error` frame (other than a rejected board op). */
  | 'server_error'
  /** The user ended the round before it began (during desk placement). */
  | 'cancelled';
export class SessionError extends Error {
  override readonly name = 'SessionError';
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export type RoundError = VoiceError | ApiError | SessionError;

/** What prepare() sets up: a new session, a retry of a report's weakest answer, or a resume. */
export type PrepareInput =
  | { kind: 'new'; req: CreateSessionReq }
  | { kind: 'retry'; parentSessionId: string; voice: VoiceChoice }
  | { kind: 'resume'; sessionId: string; voice: VoiceChoice };

/** The request a retried or resumed session stands for (mode drives the long answer rule). */
function reqFor(res: CreateSessionRes, voice: VoiceChoice): CreateSessionReq {
  return {
    mode: res.round.round_type === 'meeting' ? 'meeting' : 'interview',
    round_id: res.round.id,
    length: res.round.length,
    level: 'mid',
    style: 'neutral',
    voice,
  };
}

export interface TranscriptLine {
  panelistId: string;
  role: 'user' | 'agent';
  segmentId: string;
  text: string;
  final: boolean;
}

export interface ControllerEvents {
  state: (s: ControllerState) => void;
  error: (e: RoundError) => void;
  latency: (s: LatencySplit) => void;
  transcript: (line: TranscriptLine) => void;
  /** Round bar actions the app handles (navigation). */
  action: (a: 'retry' | 'report') => void;
  /** The session was made again before the voices joined (its voice token had run out). */
  session: (res: CreateSessionRes) => void;
}

export interface RoundControllerDeps {
  api: ApiPort;
  makeSocket(wsUrl: string, clientToken: string): SocketPort;
  makeTransport(p: Panelist, opts: TransportOptions | undefined, res: CreateSessionRes): VoiceTransport;
  xr: XRPort;
  media: MediaPort;
  avatars?: (panelistId: string) => AvatarPort | undefined;
  board?: BoardPort;
  head?: HeadSamplerPort;
  visibility?: VisibilityPort;
  timing?: Partial<RoundTiming>;
  /** Stage timings of the start (loading budget). */
  timings?: StageTimings;
}

interface CandidateTurn {
  start: number;
  lastFinal: number;
  inSegment: boolean;
  sent: boolean;
}

type VoiceStateMsg = ClientMsgMap['voice.state'] & { latency?: LatencySplit };
type RoundState = RoundStatePayload;

const isActive = (s: ControllerState) => s === 'live' || s === 'greeting' || s === 'paused';

export class RoundController {
  private readonly events = new Emitter<ControllerEvents>();
  private timing: RoundTiming;
  private readonly latency = new LatencyTracker();
  private readonly unsubs: (() => void)[] = [];
  private readonly socketUnsubs: (() => void)[] = [];
  private input: PrepareInput | null = null;
  /** True from the moment the desk is placed: the socket may say hello (the round starts on the server). */
  private socketWanted = false;
  private socketUp: Promise<void> | null = null;
  private renewed = false;
  private longAnswerMuted = false;
  private reportLoading: Promise<void> | null = null;
  private lastCard: HeadsetCard | null = null;

  private st: ControllerState = 'idle';
  private disposed = false;
  private req: CreateSessionReq | null = null;
  private res: CreateSessionRes | null = null;
  private socket: SocketPort | null = null;
  private panel: PanelController | null = null;
  private preMic: MediaStream | null = null;
  private preparing = false;
  /** A session a failed prepare() already got; the next prepare() reuses it. */
  private preparedRes: CreateSessionRes | null = null;

  // voices
  private transportSeq = 0;
  private readonly modes = new Map<VoiceTransport, VoiceMode>();
  private readonly voices = new Map<string, MediaStream>();
  private readonly quietWaiters = new Map<VoiceTransport, Set<() => void>>();
  private voicesUp = false;
  private greeted = false;
  private startPending = false;
  private sawAgent = false;
  private userMuted = false;
  private handingOver = 0;
  private pendingHandOver: { to: string; openingLine: string } | null = null;
  private voicesStarting: Promise<void> | null = null;
  private placed = false;
  private timeCheckOwed = false;
  private hearTaps = 0;
  private lastGestureUnlock = -Infinity;
  /** Replies whose first words were reported (`voice.spoken`), by panelist and segment. */
  private readonly spokenSent = new Set<string>();
  private spokenPending: { key: string; panelistId: string; text: string } | null = null;
  private longAnswerUnmute: ReturnType<typeof setTimeout> | null = null;
  private lastAgentSegment: string | null = null;
  private lastActivitySent = -Infinity;

  // greeting watchdog
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private audioBlocked = false;

  // user speech
  private readonly segments = new Map<string, number>();
  private readonly marked = new Set<string>();
  private userSpeaking = false;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private cand: CandidateTurn | null = null;
  private candTimer: ReturnType<typeof setTimeout> | null = null;

  // silence
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceFired = false;

  // socket
  private socketTerminal = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectShown = false;

  // round state from the server
  private lastRound: RoundState | null = null;
  private serverTimeChecks = false;

  // ending
  private endReason: EndReason | null = null;
  private endingSawSpeech = false;
  private endingTimer: ReturnType<typeof setTimeout> | null = null;
  private finishing: Promise<void> | null = null;
  private cardShown = false;
  /** `round.ended` arrived: scoring frames count from here, even while the voices are still stopping. */
  private serverEnded = false;

  constructor(private readonly deps: RoundControllerDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  get state(): ControllerState {
    return this.st;
  }

  get session(): CreateSessionRes | null {
    return this.res;
  }

  get floor(): string | null {
    return this.panel?.floor ?? null;
  }

  /** Recent latency splits, newest last (dev overlay). */
  get latencyHistory(): readonly LatencySplit[] {
    return this.latency.history;
  }

  on<K extends keyof ControllerEvents>(event: K, cb: ControllerEvents[K]): () => void {
    return this.events.on(event, cb);
  }

  /**
   * Starts a round in one go: prepare() then enter(). Tests and the 2D preview use it. On a
   * headset, call prepare() from the mic tap and enter() from the Enter tap instead, so the
   * network and the room loading never use up the activation that entering XR needs.
   */
  async start(req: CreateSessionReq): Promise<void> {
    await this.prepare({ kind: 'new', req });
    if (this.disposed || !this.res) return;
    await this.enter();
  }

  /**
   * Phase A, from the mic tap: the mic (or the stream the page already holds), audio unlock, the
   * session (create, retry or resume) and the room preload. Leaves the controller idle and
   * prepared. When it fails, it can be called again: a session it already got is reused.
   */
  async prepare(input: PrepareInput, opts: { mic?: MediaStream | null } = {}): Promise<void> {
    if (this.st !== 'idle' || this.req || this.preparing) {
      throw new SessionError('already_started', 'This round has already started');
    }
    this.preparing = true;
    this.input = input;
    const { media, api, xr } = this.deps;
    this.deps.timings?.mark('prepare');
    const voice = input.kind === 'new' ? input.req.voice : input.voice;
    try {
      if (opts.mic) {
        this.preMic = opts.mic;
      } else {
        try {
          this.preMic = await media.getMic();
        } catch (err) {
          const e = micError(err);
          if (voice === 'fish') {
            this.emitError(e);
            throw e;
          }
          // Typed turns work without a mic.
        }
      }
      if (this.disposed) return this.releaseMic();
      // Not awaited: resume() can stay pending until the page has activation, and must not hold up
      // the start. The voices retry playback on the next tap (unlockAudio).
      void media.resumeAudio().catch(() => undefined);

      let res = this.preparedRes;
      if (!res) {
        try {
          res =
            input.kind === 'new'
              ? await api.createSession(input.req)
              : input.kind === 'retry'
                ? await api.retry(input.parentSessionId)
                : await api.resumeSession(input.sessionId);
        } catch (err) {
          this.releaseMic();
          this.emitError(err as ApiError);
          throw err;
        }
        this.preparedRes = res;
      }
      this.deps.timings?.mark('session_created');
      if (this.disposed) return this.releaseMic();

      if (xr.preload) {
        try {
          await xr.preload(res);
        } catch (err) {
          this.releaseMic();
          const e = new SessionError('room_load_failed', 'Could not load the room', err);
          this.emitError(e);
          throw e;
        }
        if (this.disposed) return this.releaseMic();
      }

      this.req = input.kind === 'new' ? input.req : reqFor(res, voice);
      this.res = res;
      this.applyTiming(res);
      this.openSocket(res);
      this.watchPage();
      this.deps.timings?.mark('prepared');
    } finally {
      this.preparing = false;
    }
  }

  /** True once prepare() has finished and enter() can run. */
  get prepared(): boolean {
    return !!this.res && this.st === 'idle';
  }

  /**
   * Enters XR, waits for desk placement and brings the voices up. start() calls it. Call it again
   * from a new tap when entering or placement failed: it enters again when the headset session is
   * gone, and resumes at the step that failed.
   */
  async enter(): Promise<void> {
    if (this.disposed) return;
    if (!this.res) throw new SessionError('not_prepared', 'Call prepare() first');
    const { xr } = this.deps;
    const timings = this.deps.timings;

    // Phase B: the room request is the first await, so it runs inside the user's tap. A failed
    // placement means the headset session ended: the same request runs again on the retry tap.
    const first = this.st === 'idle';
    if (first || (this.st === 'placing' && xr.inSession?.() === false)) {
      if (first) timings?.mark('enter');
      try {
        await xr.enter();
      } catch (err) {
        const e = new SessionError('xr_enter_failed', 'Could not enter the room', err);
        this.emitError(e);
        throw e;
      }
      if (this.disposed) return;
      if (first) {
        if (this.st !== 'idle') return;
        timings?.mark('xr_started');
        this.setState('placing');
      }
    }
    if (this.st !== 'placing') return;

    // The voices connect while the user places the desk. Nobody hears the user until the desk is
    // down, so nothing is said before the greeting.
    if (this.panel?.isStopped) this.voicesStarting = null;
    if (!this.voicesStarting) {
      const starting = this.startVoices().then(() => void timings?.mark('voices_connected'));
      starting.catch(() => undefined); // reported below, once placement is done
      this.voicesStarting = starting;
    }
    const voices = this.voicesStarting;

    try {
      await xr.place();
    } catch (err) {
      const e = new SessionError('placement_failed', 'Could not place the desk', err);
      this.emitError(e);
      throw e; // still `placing`: enter() retries, the voices stay connected and muted
    }
    if (this.disposed || this.st !== 'placing') return;
    this.placed = true;
    timings?.mark('placed');
    // The touch that placed the desk: a good moment to retry audio that autoplay rules held back.
    this.unlockAudio();
    // The start chime plays now, with every mic still closed, and is over before anyone is asked
    // to speak.
    const cue = xr.startCue?.().catch(() => undefined) ?? Promise.resolve();

    this.setState('greeting');
    // Only now does the room say hello: the server's round clock and the round's count toward
    // limits start when the user is at the desk, not at the mic tap.
    this.socketWanted = true;
    const hello = this.connectSocket();
    try {
      await voices;
    } catch (err) {
      await this.panel?.stopAll();
      this.voicesStarting = null;
      this.releaseMic();
      const e = err instanceof VoiceError ? err : new VoiceError('connect_failed', String((err as Error)?.message ?? err), err);
      if (!this.disposed && isActive(this.st)) this.setState('failed');
      this.emitError(e);
      throw e;
    }
    await Promise.all([cue, hello]);
    this.releaseMic(); // the voice service holds its own capture now
    const panel = this.panel;
    // Ended, failed or disposed while the voices were connecting: the panel stopped them.
    if (this.disposed || !panel || panel.isStopped || !isActive(this.st)) return;

    this.voicesUp = true;
    // Paused meanwhile: everyone stays muted until Resume.
    if (this.st !== 'paused') void panel.muteAll(this.userMuted);
    const head = this.deps.head;
    if (head) {
      head.setFloor(panel.floor);
      head.start((samples) => this.socket?.send('head.samples', { samples }));
    }
    if (this.st === 'paused') this.startPending = true; // greet once the user is back
    else this.sendStart();
  }

  /**
   * Back into the headset after the user left its view (from a tap). Before the round has begun
   * this is enter(); later it re-enters and places the desk again, and the round stays paused
   * until Resume.
   */
  async returnToRoom(): Promise<void> {
    if (this.disposed) return;
    if (this.st === 'idle' || this.st === 'placing') return this.enter();
    const { xr } = this.deps;
    try {
      await xr.enter();
    } catch (err) {
      const e = new SessionError('xr_enter_failed', 'Could not enter the room', err);
      this.emitError(e);
      throw e;
    }
    await xr.place();
  }

  /** Brings the panel's voices up; a voice token that ran out is replaced by making the session again. */
  private async startVoices(): Promise<void> {
    let res = this.res!;
    if (this.tokenStale(res)) res = await this.renewSession();
    for (;;) {
      const panel = new PanelController(res, (p, o) => this.wire(this.deps.makeTransport(p, o, this.res ?? res)), {
        api: this.deps.api,
        waitQuiet: (t) => this.waitQuiet(t),
      });
      this.panel = panel;
      try {
        await panel.start();
        if (!this.placed && !panel.isStopped) void panel.muteAll(true);
        return;
      } catch (err) {
        await panel.stopAll();
        const expired = (err as VoiceError)?.code === 'session_expired';
        if (!expired || this.renewed || this.disposed || this.st === 'failed') throw err;
        res = await this.renewSession();
      }
    }
  }

  /** True when the floor's voice token is past (or about to pass) its join deadline. */
  private tokenStale(res: CreateSessionRes): boolean {
    const v = res.panel.find((p) => p.panelist_id === res.floor)?.voice;
    if (!v || v.transport !== 'fish') return false;
    const raw = v.fish.expires_at;
    if (raw == null || raw === '') return false;
    const n = typeof raw === 'number' ? raw : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isFinite(n)) return false;
    const at = n < 1e12 ? n * 1000 : n; // seconds or milliseconds since the epoch
    return at - Date.now() < TOKEN_MARGIN_MS;
  }

  /**
   * Makes the session again (same request). The earlier one never started on the server, which
   * drops it by itself. The room socket moves to the new session.
   */
  private async renewSession(): Promise<CreateSessionRes> {
    const input = this.input!;
    const { api } = this.deps;
    this.renewed = true;
    const res =
      input.kind === 'new'
        ? await api.createSession(input.req)
        : input.kind === 'retry'
          ? await api.retry(input.parentSessionId)
          : await api.resumeSession(input.sessionId);
    if (this.disposed) throw new SessionError('cancelled', 'The round was closed');
    this.res = res;
    this.preparedRes = res;
    this.applyTiming(res);
    this.closeSocket();
    this.openSocket(res);
    if (this.socketWanted) void this.connectSocket();
    this.events.emit('session', res);
    return res;
  }

  private applyTiming(res: CreateSessionRes): void {
    if (!res.timing) return;
    // The server's values for this round, level and persona; deps.timing still wins (tests).
    this.timing = {
      silenceWaitSeconds: res.timing.silence_wait_seconds,
      interruptAfterSeconds: res.timing.interrupt_after_seconds,
      ...this.deps.timing,
    };
  }

  /** The user is working on the board: resets the silence timer. */
  noteUserActivity(): void {
    const now = Date.now();
    if (now - this.lastActivitySent >= ACTIVITY_THROTTLE_MS) {
      this.lastActivitySent = now;
      for (const t of this.panel?.all() ?? []) t.noteActivity?.();
    }
    this.silenceFired = false;
    this.rearmSilence();
  }

  /** A typed user turn (dev console). */
  sendTypedTurn(text: string): void {
    this.floorT()?.sendText(text);
  }

  /** Asks the floor panelist for a time check (the server says a phase ran out). */
  timeCheck(): void {
    if (this.st === 'paused' || (this.st === 'live' && this.handingOver)) {
      this.timeCheckOwed = true; // sent on Resume, or once the hand-over is done
      return;
    }
    if (this.st === 'live') this.floorT()?.sendEvent(VOICE_MARKERS.timeCheck);
  }

  private flushTimeCheck(): void {
    if (!this.timeCheckOwed || this.st !== 'live' || this.handingOver) return;
    this.timeCheckOwed = false;
    this.floorT()?.sendEvent(VOICE_MARKERS.timeCheck);
  }

  /**
   * Retries audio that autoplay rules blocked. Call it from a user gesture (any round bar tap,
   * the placement confirm); the controller does so for every UI action.
   */
  unlockAudio(): void {
    void this.deps.media.resumeAudio().catch(() => undefined);
    for (const t of this.panel?.all() ?? []) void t.startAudio?.().catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    this.userMuted = muted;
    if (this.st !== 'paused') void this.panel?.muteAll(muted);
  }

  pause(reason?: string): void {
    if (this.st !== 'live' && this.st !== 'greeting') return;
    this.setState('paused');
    void this.panel?.muteAll(true);
    for (const t of this.panel?.all() ?? []) t.interrupt?.();
    this.socket?.send('ui.event', reason ? { kind: 'pause', reason } : { kind: 'pause' });
    this.clearTimers();
    this.clearWatchdog();
    this.resetUserSpeech();
  }

  resume(): void {
    if (this.st !== 'paused') return;
    void this.panel?.muteAll(this.userMuted);
    this.socket?.send('ui.event', { kind: 'resume' });
    this.setState(this.greeted ? 'live' : 'greeting');
    const handOver = this.pendingHandOver;
    this.pendingHandOver = null;
    if (this.startPending) {
      this.startPending = false;
      this.sendStart();
    } else if (handOver) {
      // The new panelist's opening line is the welcome back.
      this.handOver(handOver.to, handOver.openingLine);
    } else if (this.voicesUp) {
      this.floorT()?.sendEvent(VOICE_MARKERS.resume);
      // Still not greeted: keep offering "Tap to hear" if the voice stays silent.
      if (!this.greeted) this.armWatchdog();
    }
    this.flushTimeCheck();
  }

  /** Ends the round: the interviewer says goodbye, then the round is scored. */
  end(reason: EndReason = 'user_ended'): void {
    // Before the round began (still placing the desk, or never entered): nothing to score.
    if (this.st === 'placing' || (this.st === 'idle' && this.res)) return void this.cancel();
    if (!isActive(this.st)) return;
    this.socket?.send('ui.event', { kind: 'end' });
    this.beginEnding(reason);
  }

  /** Ends a round that never began: the voices stop and the room never says hello to the server. */
  private async cancel(): Promise<void> {
    this.clearTimers();
    this.clearWatchdog();
    this.voicesStarting = null;
    this.setState('failed');
    this.releaseMic();
    this.closeSocket();
    await this.panel?.stopAll();
    if (!this.disposed) this.emitError(new SessionError('cancelled', 'The round was ended before it began'));
  }

  /** Tears everything down (leaving the page). */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimers();
    this.clearWatchdog();
    if (this.endingTimer) clearTimeout(this.endingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.longAnswerUnmute) clearTimeout(this.longAnswerUnmute);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = null;
    this.longAnswerUnmute = null;
    for (const u of this.unsubs.splice(0)) u();
    this.deps.head?.stop();
    this.releaseMic();
    await this.panel?.stopAll();
    this.closeSocket();
    this.deps.xr.dispose?.();
  }

  // ---------- wiring ----------

  private openSocket(res: CreateSessionRes): void {
    const s = this.deps.makeSocket(res.ws_url, res.client_token);
    this.socket = s;
    this.socketUp = null;
    this.socketTerminal = false;
    this.socketUnsubs.push(
      s.on('round.state', (d) => this.onRoundState(d)),
      s.on('panel.hand_over', (d) => this.handOver(d.to, d.opening_line)),
      // The interviewer said its closing line and ended the round itself: no second goodbye.
      s.on('round.ending', () => this.beginEnding(null, false)),
      s.on('round.ended', () => this.onRoundEnded()),
      s.on('report.progress', (d) => this.onReportProgress(d)),
      s.on('report.ready', () => void this.showReport()),
      s.on('error', (d) => {
        // Rejected board ops belong to the board.
        if (d.code === 'op_rejected') return;
        this.emitError(new SessionError('server_error', d.message, d));
        if (d.code === 'report_failed') this.reportUnavailable();
      }),
    );
    if (s.onTerminal) {
      this.socketUnsubs.push(
        s.onTerminal((info) => {
          if (this.disposed) return;
          this.socketTerminal = true;
          // After the round the server closes the room for good once the report is done (or late).
          if (this.st === 'summary') return;
          if (this.st === 'scoring' || (this.serverEnded && this.st === 'ending')) {
            void this.showReport(true);
            return;
          }
          this.emitError(new SessionError('socket_terminal', `The room connection closed (${info.code})`, info));
          this.deps.xr.ui.setStatus('We lost the connection to the room');
        }),
      );
    }
    if (s.onStatus) this.socketUnsubs.push(s.onStatus((st) => this.onSocketStatus(st)));
  }

  /**
   * Connects the room socket (hello). Resolves once the server has answered, or shortly after, or
   * when the connection failed (reported as an error): the start never hangs on it.
   */
  private connectSocket(): Promise<void> {
    const s = this.socket;
    if (!s) return Promise.resolve();
    this.socketUp ??= s
      .connect()
      .then(() => {
        const heard = s.heard?.();
        if (!heard) return;
        return Promise.race([heard, new Promise<void>((r) => setTimeout(r, HELLO_WAIT_MS))]);
      })
      .catch((err) => {
        if (this.disposed || this.socketTerminal || this.socket !== s) return;
        this.emitError(new SessionError('socket_failed', 'Could not connect to the room', err));
      });
    return this.socketUp;
  }

  private closeSocket(): void {
    for (const u of this.socketUnsubs.splice(0)) u();
    this.socket?.close();
    this.socket = null;
    this.socketUp = null;
  }

  private onSocketStatus(st: string): void {
    if (st === 'reconnecting') {
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.disposed || this.socketTerminal) return;
        this.reconnectShown = true;
        this.emitError(new SessionError('socket_failed', 'Reconnecting to the room'));
        this.deps.xr.ui.setStatus('Reconnecting to the room');
      }, RECONNECT_WARN_MS);
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (st === 'open' && this.reconnectShown) {
      this.reconnectShown = false;
      this.deps.xr.ui.setStatus(null);
    }
  }

  private watchPage(): void {
    const v = this.deps.visibility;
    if (v) {
      const onVis = () => {
        if (v.visibilityState === 'hidden') this.pause('hidden');
      };
      v.addEventListener('visibilitychange', onVis);
      this.unsubs.push(() => v.removeEventListener('visibilitychange', onVis));
    }
    const board = this.deps.board;
    if (board) this.unsubs.push(board.onActivity(() => this.noteUserActivity()));
    this.unsubs.push(this.deps.xr.ui.onAction((a) => this.onAction(a)));
    const onGesture = this.deps.xr.onGesture;
    if (onGesture) {
      this.unsubs.push(
        onGesture(() => {
          // A pinch is a user gesture too (the placement touch, drawing): retry blocked audio.
          const now = Date.now();
          if (now - this.lastGestureUnlock < GESTURE_UNLOCK_MS) return;
          this.lastGestureUnlock = now;
          this.unlockAudio();
        }),
      );
    }
  }

  private onAction(a: UiAction): void {
    // Every action is a tap: a chance to start playback that autoplay rules held back.
    this.unlockAudio();
    switch (a) {
      case 'mute':
        return this.setMuted(true);
      case 'unmute':
        return this.setMuted(false);
      case 'pause':
        return this.pause();
      case 'resume':
        return this.resume();
      case 'end':
        return this.end();
      case 'hear':
        return this.hearAgain();
      case 'retry':
      case 'report':
        return this.events.emit('action', a);
    }
  }

  private wire(t: VoiceTransport): VoiceTransport {
    const gen = ++this.transportSeq;
    t.on('mode', (m) => this.onMode(t, m));
    t.on('userTranscript', (e) => this.onUser(t, gen, e));
    t.on('agentText', (e) => this.onAgentText(t, e));
    t.on('ended', (e) => this.onEnded(t, e.reason));
    t.on('error', (e) => this.emitError(e));
    return t;
  }

  private floorT(): VoiceTransport | undefined {
    return this.panel?.current();
  }

  private openingMarker(): string {
    return this.input?.kind === 'resume' ? VOICE_MARKERS.resume : VOICE_MARKERS.start;
  }

  private sendStart(): void {
    // A resumed round picks up where it was: the interviewer welcomes the user back, it does not open again.
    this.floorT()?.sendEvent(this.openingMarker());
    this.deps.timings?.mark('start_sent');
    this.armWatchdog();
  }

  private handOver(to: string, openingLine: string): void {
    if (this.st === 'paused' || this.st === 'greeting') {
      // Nobody new speaks while the user is away, and nobody takes over before the greeting is
      // done (a swap during the greeting would greet twice). Replayed on Resume or once live.
      this.pendingHandOver = { to, openingLine };
      return;
    }
    if (this.st !== 'live') return;
    const panel = this.panel;
    if (!panel || panel.isStopped) return;
    this.handingOver++;
    this.clearTimers();
    this.resetUserSpeech();
    panel
      .handOver(to, openingLine)
      .then(() => {
        const live = new Set(panel.all());
        for (const t of [...this.modes.keys()]) if (!live.has(t)) this.modes.delete(t);
        if (!panel.isStopped) this.deps.head?.setFloor(panel.floor);
      })
      .catch((err) => this.emitError(err instanceof VoiceError ? err : new VoiceError('connect_failed', String(err), err)))
      .finally(() => {
        this.handingOver--;
        this.rearmSilence();
        this.flushTimeCheck();
      });
  }

  /** Resolves when the transport's agent is not speaking, or after HANDOFF_WAIT_MS. */
  private waitQuiet(t: VoiceTransport): Promise<void> {
    if (this.modes.get(t) !== 'speaking') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let set = this.quietWaiters.get(t);
      if (!set) this.quietWaiters.set(t, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, HANDOFF_WAIT_MS);
      set.add(done);
    });
  }

  // ---------- greeting watchdog ----------

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.st !== 'greeting' || this.greeted || this.disposed) return;
      this.audioBlocked = true;
      this.emitError(new VoiceError('audio_blocked', 'The interviewer has not been heard yet'));
      this.deps.xr.ui.setStatus('Tap to hear your interviewer');
    }, GREETING_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /**
   * The "Tap to hear" action. The tap itself retries playback (unlockAudio in onAction). The start
   * marker is sent again only when the agent never reacted at all, and for a real voice only from
   * the second tap on: a voice held back by autoplay rules still has the first greeting queued,
   * and a second marker would make it greet twice.
   */
  private hearAgain(): void {
    if (this.st !== 'greeting' || !this.voicesUp) return;
    if (this.audioBlocked) {
      this.audioBlocked = false;
      this.deps.xr.ui.setStatus(null);
    }
    const taps = this.hearTaps++;
    if (!this.sawAgent && (taps > 0 || this.req?.voice === 'fake')) this.floorT()?.sendEvent(this.openingMarker());
    this.armWatchdog();
  }

  // ---------- voice events ----------

  private onMode(t: VoiceTransport, m: VoiceMode): void {
    const now = Date.now();
    this.modes.set(t, m);
    if (m !== 'speaking') for (const done of [...(this.quietWaiters.get(t) ?? [])]) done();
    const avatar = this.deps.avatars?.(t.panelistId);
    avatar?.setMode(m);
    if (m === 'speaking' && avatar) {
      const stream = t.outputStream();
      if (stream && this.voices.get(t.panelistId) !== stream) {
        this.voices.set(t.panelistId, stream);
        avatar.attachVoice(stream);
      }
    }
    if (m === 'thinking') this.latency.thinking(now);
    if (m === 'thinking' || m === 'speaking') {
      this.sawAgent = true;
      this.endLongAnswerMute(); // the agent took the turn: the mic opens again
    }
    // The reply is over: report a short one that never reached the usual length.
    if (m !== 'speaking' && this.spokenPending?.panelistId === t.panelistId) this.flushSpoken();
    if (m === 'speaking') {
      this.deps.timings?.mark('first_audio');
      this.cand = null; // the agent answered: the candidate's turn is over
      this.silenceFired = false;
      this.greeted = true;
      this.clearWatchdog();
      if (this.audioBlocked) {
        this.audioBlocked = false;
        this.deps.xr.ui.setStatus(null);
      }
      if (this.st === 'ending') this.endingSawSpeech = true;
    }

    const msg: VoiceStateMsg = { panelist_id: t.panelistId, mode: m, at_ms: now };
    const split = this.latency.take();
    if (split) msg.latency = split;
    this.socket?.send('voice.state', msg);

    if (m === 'listening') {
      if (this.st === 'greeting' && this.greeted) this.goLive();
      if (this.st === 'ending' && this.endingSawSpeech) void this.finishEnding();
    }
    this.rearmSilence();
  }

  private onUser(t: VoiceTransport, gen: number, e: UserTranscript): void {
    // Only the floor hears the user; anything else is a second session catching the same speech.
    if (t !== this.floorT() || isMarker(e.text)) return;
    const key = `${t.panelistId}.${gen}.${e.segmentId}`;
    if (this.marked.has(key)) return;
    const now = Date.now();
    if (!this.segments.has(key)) this.segments.set(key, now);

    if (!this.userSpeaking) this.setUserSpeaking(true);
    if (this.st === 'live') this.trackTurn(now, e.final);
    this.silenceFired = false;

    if (e.final) {
      const first = this.segments.get(key) ?? now;
      this.segments.delete(key);
      this.marked.add(key);
      this.setUserSpeaking(false);
      this.socket?.send('transcript.mark', {
        segment_id: key,
        panelist_id: t.panelistId,
        first_at_ms: first,
        final_at_ms: now,
        text: e.text,
      });
      const agentPlaying = this.agentIs('speaking') ? this.lastAgentSegment : null;
      this.latency.userFinal(now, agentPlaying);
      if (this.st === 'greeting') this.goLive();
    } else {
      this.armStaleSegment();
    }
    this.events.emit('transcript', {
      panelistId: t.panelistId,
      role: 'user',
      segmentId: key,
      text: e.text,
      final: e.final,
    });
    this.rearmSilence();
  }

  private onAgentText(t: VoiceTransport, e: AgentText): void {
    this.sawAgent = true;
    this.lastAgentSegment = e.segmentId;
    const split = this.latency.agentText(Date.now(), e.segmentId);
    if (split) this.events.emit('latency', split);
    this.noteSpoken(t.panelistId, e);
    this.events.emit('transcript', {
      panelistId: t.panelistId,
      role: 'agent',
      segmentId: `${t.panelistId}.${e.segmentId}`,
      text: e.text,
      final: false,
    });
  }

  /** Greeting over: the round is live, and a hand-over that waited for it runs now. */
  private goLive(): void {
    this.setState('live');
    const h = this.pendingHandOver;
    if (!h || this.st !== 'live') return;
    this.pendingHandOver = null;
    this.handOver(h.to, h.openingLine);
  }

  /**
   * `voice.spoken`: the first words of a reply as they played, once per reply. Sent as soon as
   * enough has played, so the server's actions for the reply land while it is being said.
   */
  private noteSpoken(panelistId: string, e: AgentText): void {
    const key = `${panelistId}.${e.segmentId}`;
    if (this.spokenSent.has(key)) return;
    if (this.spokenPending && this.spokenPending.key !== key) this.flushSpoken();
    this.spokenPending = { key, panelistId, text: e.text };
    if (e.text.trim().length >= SPOKEN_MIN_CHARS) this.flushSpoken();
  }

  private flushSpoken(): void {
    const p = this.spokenPending;
    this.spokenPending = null;
    if (!p) return;
    const text = p.text.trim();
    if (!text) return;
    this.spokenSent.add(p.key);
    this.socket?.send('voice.spoken', { panelist_id: p.panelistId, text_prefix: [...text].slice(0, SPOKEN_MAX_CHARS).join('') });
  }

  private onEnded(t: VoiceTransport, reason: string): void {
    this.modes.delete(t);
    // A voice that stops mid-sentence sends no last mode: its avatar must not stay "speaking".
    this.deps.avatars?.(t.panelistId)?.setMode('idle');
    for (const done of [...(this.quietWaiters.get(t) ?? [])]) done();
    // Transports we stop (hand-over, round end) are not the floor any more by then; a floor that
    // ends mid hand-over is being replaced.
    if (this.floorT() !== t || this.finishing || this.handingOver) return;
    if (isActive(this.st)) {
      this.emitError(new VoiceError('voice_lost', `The voice connection ended (${reason})`));
      this.deps.xr.ui.setStatus('We lost the connection to your interviewer');
    }
  }

  private setUserSpeaking(b: boolean): void {
    this.userSpeaking = b;
    this.deps.head?.setUserSpeaking(b);
    if (!b && this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  /** A segment that never finalizes (mute, pause, dropped voice) must not block silence checks. */
  private armStaleSegment(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      this.resetUserSpeech();
      this.rearmSilence();
    }, USER_SEGMENT_STALE_MS);
  }

  private resetUserSpeech(): void {
    this.segments.clear();
    if (this.cand) this.cand.inSegment = false; // that segment is over, so is its turn's run
    if (this.userSpeaking) this.setUserSpeaking(false);
  }

  // ---------- long answers ----------

  private trackTurn(now: number, final: boolean): void {
    let c = this.cand;
    if (!c || (!c.inSegment && now - c.lastFinal >= TURN_GAP_MS)) {
      c = { start: now, lastFinal: now, inSegment: false, sent: false };
      this.cand = c;
      if (this.candTimer) clearTimeout(this.candTimer);
      const turn = c;
      this.candTimer = setTimeout(() => {
        this.candTimer = null;
        if (this.cand === turn) this.checkLongAnswer();
      }, this.timing.interruptAfterSeconds * 1000 + 1);
    }
    c.inSegment = !final;
    if (final) c.lastFinal = now;
    this.checkLongAnswer();
  }

  private checkLongAnswer(): void {
    const c = this.cand;
    if (!c || c.sent || this.req?.mode !== 'interview' || this.st !== 'live' || this.handingOver) return;
    if (this.agentIs('speaking')) return;
    const now = Date.now();
    const ongoing = c.inSegment || now - c.lastFinal < TURN_GAP_MS;
    if (ongoing && now - c.start > this.timing.interruptAfterSeconds * 1000) {
      c.sent = true;
      void this.sendLongAnswer();
    }
  }

  /**
   * The voice service ignores typed turns while it hears the user talk. So: close the mic and wait
   * until that has really taken effect, give the service a moment to see the turn end, send the
   * marker, and open the mic again once the agent takes the turn (or shortly after). Whatever
   * fails on the way, the mic opens again.
   */
  private async sendLongAnswer(): Promise<void> {
    const panel = this.panel;
    const t = this.floorT();
    if (!panel || !t) return;
    this.longAnswerMuted = true;
    let sent = false;
    try {
      await Promise.race([panel.muteAll(true), new Promise<void>((r) => setTimeout(r, MUTE_WAIT_MS))]);
      await new Promise<void>((r) => setTimeout(r, LONG_ANSWER_SETTLE_MS));
      const still = this.longAnswerMuted && !this.disposed && this.st === 'live' && !this.handingOver && this.floorT() === t;
      if (still && !this.agentIs('speaking', 'thinking')) {
        t.sendEvent(VOICE_MARKERS.longAnswer);
        sent = true;
      }
    } catch {
      // the mute failed: no marker, and the mic is opened again below
    } finally {
      if (!this.longAnswerMuted) {
        // already opened again (the agent took the turn meanwhile)
      } else if (sent) {
        if (this.longAnswerUnmute) clearTimeout(this.longAnswerUnmute);
        this.longAnswerUnmute = setTimeout(() => this.endLongAnswerMute(), LONG_ANSWER_MUTE_MS);
      } else {
        this.endLongAnswerMute();
      }
    }
  }

  private endLongAnswerMute(): void {
    if (!this.longAnswerMuted) return;
    this.longAnswerMuted = false;
    if (this.longAnswerUnmute) clearTimeout(this.longAnswerUnmute);
    this.longAnswerUnmute = null;
    // Paused or ending keep their own mute (Resume opens the mic again).
    if (this.st === 'live' || this.st === 'greeting') void this.panel?.muteAll(this.userMuted);
  }

  // ---------- silence ----------

  private agentIs(...ms: VoiceMode[]): boolean {
    for (const m of this.modes.values()) if (ms.includes(m)) return true;
    return false;
  }

  private rearmSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.disposed) return;
    if (!this.silenceCanRun()) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (!this.silenceCanRun()) return;
      this.silenceFired = true;
      this.floorT()?.sendEvent(VOICE_MARKERS.silenceCheck);
    }, this.timing.silenceWaitSeconds * 1000);
  }

  private silenceCanRun(): boolean {
    return (
      this.st === 'live' &&
      !this.handingOver &&
      !this.silenceFired &&
      !this.userSpeaking &&
      !this.agentIs('thinking', 'speaking')
    );
  }

  private clearTimers(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.candTimer) clearTimeout(this.candTimer);
    this.silenceTimer = null;
    this.candTimer = null;
    this.cand = null;
  }

  // ---------- server round state ----------

  private onRoundState(d: RoundState): void {
    const prev = this.lastRound;
    this.lastRound = d;
    this.deps.xr.ui.setRoundState({ ...d, controller: this.st });
    if (d.time_check_due !== undefined) {
      // The server says when; once it does, the phase heuristic is off.
      this.serverTimeChecks = true;
      if (d.time_check_due && !prev?.time_check_due) this.timeCheck();
      return;
    }
    if (this.serverTimeChecks) return;
    if (prev && d.phase_index > prev.phase_index && prev.phase_remaining_s <= PHASE_TIME_SLACK_S) {
      this.timeCheck();
    }
  }

  // ---------- ending and scoring ----------

  /**
   * reason null: the server ends the round (time limit, end_round) and reports it itself.
   * `ask`: ask the floor for a goodbye. Not when the interviewer closed the round itself: its
   * closing line is already playing, and a second request would make a second goodbye.
   */
  private beginEnding(reason: EndReason | null, ask = true): void {
    if (!isActive(this.st)) return;
    this.endReason = reason;
    this.endingSawSpeech = false;
    this.pendingHandOver = null;
    this.clearTimers();
    this.clearWatchdog();
    this.endLongAnswerMute();
    this.deps.board?.roundEnding?.();
    this.setState('ending');
    if (!this.voicesUp) {
      void this.finishEnding(); // nobody to say goodbye yet
      return;
    }
    if (ask) {
      this.floorT()?.sendEvent(VOICE_MARKERS.ending);
      this.endingTimer = setTimeout(() => void this.finishEnding(), ENDING_GRACE_MS);
      return;
    }
    // The closing line is playing (finish when it ends), about to play, or already over.
    this.endingSawSpeech = this.agentIs('speaking');
    const wait = this.agentIs('speaking', 'thinking') ? ENDING_GRACE_MS : QUIET_CLOSE_MS;
    this.endingTimer = setTimeout(() => void this.finishEnding(), wait);
  }

  /**
   * The server closed the round. It does so a few seconds after the closing line's text, which
   * can be before the voice has finished saying it: the line plays on (bounded), then the voices
   * stop. Scoring frames count from now on either way.
   */
  private onRoundEnded(): void {
    const wasActive = isActive(this.st);
    if (!wasActive && this.st !== 'ending') return;
    this.serverEnded = true;
    this.endReason = null;
    if (wasActive) this.beginEnding(null, false);
    if (this.st !== 'ending' || this.finishing) return;
    const talking = this.agentIs('speaking', 'thinking');
    if (!talking && (wasActive || this.endingSawSpeech)) {
      void this.finishEnding();
      return;
    }
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.endingTimer = setTimeout(() => void this.finishEnding(), GOODBYE_CAP_MS);
  }

  private finishEnding(): Promise<void> {
    if (!this.finishing) this.finishing = this.doFinish();
    return this.finishing;
  }

  private async doFinish(): Promise<void> {
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.endingTimer = null;
    this.clearTimers();
    this.clearWatchdog();
    this.resetUserSpeech();
    this.deps.head?.stop();
    this.flushSpoken();
    await this.panel?.stopAll();
    if (this.disposed) return;
    // Nobody is talking any more: the people at the table sit and wait through scoring and the summary.
    for (const p of this.res?.panel ?? []) this.deps.avatars?.(p.panelist_id)?.setMode('idle');
    // The scorecard can beat the voices' shutdown: never go back from the summary or cover the card.
    if (this.st !== 'summary') {
      this.setState('scoring');
      if (!this.cardShown) this.deps.xr.ui.setStatus('Writing your scorecard', 0);
    }
    const res = this.res;
    if (res && this.endReason) {
      await this.deps.api.endSession(res.session_id, this.endReason).catch((e) => this.emitError(e as ApiError));
    }
  }

  /** Scoring progress (pct 0 to 100), and the quick card a few seconds after the round. */
  private onReportProgress(d: { stage: string; pct: number; card?: HeadsetCard }): void {
    if (this.st !== 'scoring' && !(this.serverEnded && this.st === 'ending')) return;
    const ui = this.deps.xr.ui;
    if (d.stage === 'card' && d.card && ui.showCard) {
      this.cardShown = true;
      this.lastCard = d.card;
      ui.setStatus(null);
      ui.showCard(d.card);
      return;
    }
    // Once the card is up it stays; the summary replaces it when the report is ready.
    if (!this.cardShown) ui.setStatus('Writing your scorecard', Math.max(0, Math.min(1, d.pct / 100)));
  }

  /**
   * The report is ready (or the room closed while it was being written: `late`). One load at a
   * time, however many signals ask for it (report.ready is followed at once by the room closing).
   * A read that fails is tried again a few times; if it still cannot be read, the user gets a card
   * with a way on: the report page keeps trying.
   */
  private showReport(late = false): Promise<void> {
    if (!this.res || this.st === 'summary' || this.disposed) return Promise.resolve();
    this.reportLoading ??= this.loadReport(late).finally(() => (this.reportLoading = null));
    return this.reportLoading;
  }

  private async loadReport(late: boolean): Promise<void> {
    const id = this.res!.session_id;
    let last: unknown = null;
    for (let attempt = 0; attempt <= REPORT_RETRIES; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, REPORT_RETRY_MS));
      if (this.disposed || this.st === 'summary') return;
      try {
        const report = await this.deps.api.report(id);
        if (this.disposed || (this.st as ControllerState) === 'summary') return;
        this.deps.xr.ui.setStatus(null);
        this.deps.xr.ui.showSummary(report);
        this.setState('summary');
        return;
      } catch (err) {
        last = err;
      }
    }
    if (this.disposed) return;
    if (!late) this.emitError(last as ApiError);
    this.reportUnavailable();
  }

  /** No report in the headset: keep the quick card (without its "almost ready" line), or show a short one, with See full report. */
  private reportUnavailable(): void {
    if ((this.st !== 'scoring' && !(this.serverEnded && this.st === 'ending')) || this.disposed) return;
    const ui = this.deps.xr.ui;
    if (this.cardShown && this.lastCard) {
      ui.showCard?.(this.lastCard, { pending: false });
    } else if (!this.cardShown) {
      ui.setStatus(null);
      if (ui.showCard) ui.showCard({ one_line: 'Your scorecard is taking longer than usual. Open the full report to see it.', top_strength: null, top_fix: null }, { pending: false });
      else ui.setStatus('Your scorecard is taking longer than usual');
      this.cardShown = true;
    }
    this.setState('summary');
  }

  // ---------- helpers ----------

  private setState(s: ControllerState): void {
    if (this.st === s) return;
    this.st = s;
    if (this.lastRound) this.deps.xr.ui.setRoundState({ ...this.lastRound, controller: s });
    this.events.emit('state', s);
    if (s === 'live') this.rearmSilence();
  }

  private releaseMic(): void {
    for (const tr of this.preMic?.getTracks() ?? []) tr.stop();
    this.preMic = null;
  }

  private emitError(e: RoundError): void {
    this.events.emit('error', e);
  }
}

function micError(err: unknown): VoiceError {
  const name = (err as { name?: string })?.name;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new VoiceError('no_mic', 'No microphone was found', err);
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new VoiceError('mic_busy', 'The microphone is in use by another app', err);
  }
  return new VoiceError('mic_denied', 'Microphone access was not allowed', err);
}
