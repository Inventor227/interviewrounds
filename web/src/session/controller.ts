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
// - Pause in any active state (greeting, live, mid hand-over, while anyone speaks): the Pause
//   button, the headset session losing visibility (system menu, headset off) or ending, the page
//   hidden. The mic closes, the interviewer stops mid-word, an open user segment is dropped, and
//   nothing resumes by itself: the user presses Resume. After 45 s the server releases the voices;
//   Resume then gets new ones (`POST /resume`) before the interviewer welcomes the user back.
// - A voice that drops mid round is replaced the same way, by itself; if that fails the user gets
//   a card with Resume and End.
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
import { NOTICES, type NoticeKind } from './notices';
import type { StageTimings } from './timings';
import type {
  ApiPort,
  AvatarPort,
  BoardPort,
  ControllerState,
  HeadSamplerPort,
  MediaPort,
  PauseReason,
  SocketPort,
  UiAction,
  VisibilityPort,
  XRPort,
  XRVisibilityLike,
} from './ports';

/** Not part of RoundPublic yet; the server keeps them. Defaults match the round content. */
export interface RoundTiming {
  silenceWaitSeconds: number;
  interruptAfterSeconds: number;
}
export const DEFAULT_TIMING: RoundTiming = { silenceWaitSeconds: 20, interruptAfterSeconds: 120 };

/**
 * Segments closer than this belong to the same candidate turn. The voice service ends a transcript segment at every
 * short pause and its next interim comes about 1.2 s after the speech resumes, so the gap between two segments of
 * one answer is often 1.2 to 2 s.
 */
export const TURN_GAP_MS = 3000;
/**
 * A reply ends the candidate's turn when it played to its end (its last words close a sentence and the candidate was
 * not talking over it), whatever its length, or when one start of it played this long. The voice service starts a
 * reply at short pauses and the candidate's next words cut it off within a fraction of a second; such starts do not
 * end the turn, however many there are.
 */
export const AGENT_REPLY_MS = 2000;
/** Longest wait for the goodbye line before the round is closed anyway. */
export const ENDING_GRACE_MS = 15_000;
/**
 * Longest wait for the outgoing panelist to finish its sentence before a hand-over, once it is speaking. Long, so
 * a long hand-off sentence is never cut: the new voice is joined meanwhile, so the gap after it stays short.
 */
export const HANDOFF_WAIT_MS = 15_000;
/**
 * Longest wait for a panelist who is thinking (or was just asked for its opening line) to start speaking before a
 * hand-over goes on without its sentence.
 */
export const HANDOFF_START_MS = 4000;
/** No agent speech this long after `[event: start]` → offer "Tap to hear your interviewer". */
export const GREETING_WATCHDOG_MS = 8000;
/** A user segment with no update for this long is treated as over (it never finalized). */
export const USER_SEGMENT_STALE_MS = 10_000;
/** Reconnecting for longer than this is reported as a typed error (the banner shows sooner). */
export const RECONNECT_WARN_MS = 8000;
/** A socket that has been reconnecting this long shows the "Reconnecting…" banner. */
export const RECONNECT_BANNER_MS = 1500;
/** New voices that take longer than this show the card with Resume and End while the try goes on. */
export const VOICE_HOLD_MS = 8000;
/** Scoring that takes longer than this offers the way to History. */
export const SCORING_SLOW_MS = 60_000;
/** `voice.spoken` goes out once this much of a reply has played (or when a shorter reply ends). */
export const SPOKEN_MIN_CHARS = 24;
/** At most this much of the reply is reported. */
export const SPOKEN_MAX_CHARS = 60;
/** The mic stays closed this long at most around a typed long-answer marker when the interviewer does not react. */
export const LONG_ANSWER_MUTE_MS = 2500;
/**
 * Once the interviewer reacts to the marker (thinking), the mic stays closed until its cut-in has been audible this
 * long, and `LONG_ANSWER_MAX_MUTE_MS` at most in all, counted from the marker (however often the voice reports
 * thinking or speaking again). With a real voice the cut-in came 3.7 s after the marker; a candidate still talking
 * when the mic reopened at `thinking` cut it off at its first word.
 */
export const LONG_ANSWER_CUT_IN_MS = 1500;
export const LONG_ANSWER_MAX_MUTE_MS = 8000;
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
/** The server drops a session that has not said hello for 10 minutes; past this it is made again. */
export const UNSTARTED_SESSION_MS = 9 * 60 * 1000;
/** `POST /resume` answers that mean the round is over (the pause budget ran out, or it ended). */
const RESUME_GONE: ReadonlySet<string> = new Set(['session_ended', 'resume_expired', 'resume_limit']);
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
  action: (a: 'retry' | 'report' | 'history') => void;
  /** The card for the current interruption changed (session/notices.ts); null when there is none. */
  notice: (n: NoticeKind | null) => void;
  /** The session was made again before the voices joined (its voice token had run out). */
  session: (res: CreateSessionRes) => void;
}

export interface RoundControllerDeps {
  api: ApiPort;
  /** `lastSeq`: the highest server seq already seen on an earlier socket of this session (0 for the first). */
  makeSocket(wsUrl: string, clientToken: string, lastSeq?: number): SocketPort;
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
  /** The longest single start of the interviewer's speech since this turn began (cut-off starts stay short). */
  agentLongest: number;
  /** A reply played to its end since this turn began: the candidate's next words are a new answer. */
  answered: boolean;
}

/** True when a reply's played text closes a sentence (a reply cut off mid-sentence does not). */
function endsSentence(text: string): boolean {
  return /[.!?\u2026]["')\]\u201d\u2019]*$/.test(text.trim());
}

type VoiceStateMsg = ClientMsgMap['voice.state'] & { latency?: LatencySplit };
type RoundState = RoundStatePayload;

/** Session statuses that mean the round itself is over. */
const ROUND_OVER: ReadonlySet<string> = new Set(['scoring', 'scored', 'failed', 'abandoned']);

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
  private sessionAt = 0;
  private helloSent = false;
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
  /** Hand-overs waiting for a voice's sentence to be over: told of every mode change of that voice, and its end. */
  private readonly quietWaiters = new Map<VoiceTransport, Set<(m: VoiceMode | 'ended') => void>>();
  /** A hand-over released by Resume whose opening line is the welcome back (none was asked for otherwise). */
  private welcomeBackBy: { to: string } | null = null;
  private voicesUp = false;
  private greeted = false;
  private startPending = false;
  private sawAgent = false;
  private userMuted = false;
  private handingOver = 0;
  /** A hand-over heard while the round could not take it (paused, greeting): Resume or going live runs it. */
  private pendingHandOver: { to: string } | null = null;
  /** Hand-overs under way, oldest first (the panel runs them one at a time). */
  private readonly flight: { to: string }[] = [];
  /** A hand-over that was caught by a pause before the new voice took the floor: it waits for Resume. */
  private gatedHandOver: { to: string } | null = null;
  private pauseWaiters: (() => void)[] = [];

  // pause
  /** The user was away (headset off, system menu, page hidden, session ended) during this pause. */
  private away = false;
  /** The floor's voice is gone (released by the server during a pause, or lost): Resume needs new voices. */
  private voicesGone = false;
  /** The voice dropped mid round and could not be brought back yet. */
  private voiceLost = false;
  private resuming: Promise<void> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdOver = false;
  /** The mic stays closed while the start chime plays, whatever is pressed meanwhile. */
  private micHeld = false;
  /** New voices were made during this pause and have not been asked to speak yet. */
  private rebuilt = false;
  /** Each voice transport's number in this round (`wire`): a reply is one voice's, whatever its segment id. */
  private readonly voiceNo = new WeakMap<VoiceTransport, number>();
  private degraded = false;
  /** The user came back into view during this pause: the card says "Welcome back". */
  private cameBack = false;
  private scoringPct = 0;
  private shownNotice: NoticeKind | null = null;
  private endedPaused = false;
  private scoringSlow = false;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private voicesStarting: Promise<void> | null = null;
  private placed = false;
  private timeCheckOwed = false;
  private hearTaps = 0;
  private lastGestureUnlock = -Infinity;
  /** Replies whose first words were reported (`voice.spoken`), by panelist and segment. */
  private readonly spokenSent = new Set<string>();
  private spokenPending: { key: string; panelistId: string; text: string } | null = null;
  private longAnswerUnmute: ReturnType<typeof setTimeout> | null = null;
  /** When the long-answer mute ends at the latest: the marker's time plus LONG_ANSWER_MAX_MUTE_MS (0 before the marker). */
  private longAnswerDeadline = 0;
  /** What the floor's current reply has played so far (cleared when the candidate speaks). */
  private agentSaid = '';
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
  /** When the floor began speaking, while it speaks (for how long a reply lasted before the candidate went on). */
  private agentSpeakingSince: number | null = null;
  private candTimer: ReturnType<typeof setTimeout> | null = null;

  // silence
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceFired = false;

  // socket
  private socketTerminal = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private socketDown = false;
  private socketDropped = false;

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

  /** The card for the current interruption, if any (session/notices.ts). */
  get notice(): NoticeKind | null {
    return this.shownNotice;
  }

  /** True when the round ended because its pause budget ran out. */
  get endedWhilePaused(): boolean {
    return this.endedPaused;
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
        this.sessionAt = Date.now();
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
      if (input.kind === 'resume') {
        // A resumed round is already running and counted on the server, and its offline clock is
        // ticking: say hello now, not at the desk.
        this.socketWanted = true;
        void this.connectSocket();
      }
      this.watchPage();
      this.deps.timings?.mark('prepared');
    } finally {
      this.preparing = false;
    }
  }

  /** True once the room has said hello to the server: from then on the round has started there and counts. */
  get started(): boolean {
    return this.helloSent;
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
    if (!this.voicesStarting) this.connectVoices();

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

    // First round with a board: the user draws one box before anyone speaks. The round (hello,
    // the server's clock, the opening) starts only when that is done or skipped.
    // A resumed round is already running on the server: nothing holds it back.
    if (xr.onboard && this.input?.kind !== 'resume') {
      const taught = await xr.onboard().catch(() => 'none' as const);
      // Also when a second enter() (the page's way back) waited on the same step: the first to
      // get here moves the round on, the other finds it no longer placing.
      if (this.disposed || this.st !== 'placing') return;
      if (taught !== 'none') {
        void this.deps.api.onboardingDone?.().catch(() => undefined);
        if (taught === 'skipped') this.socket?.send('ui.event', { kind: 'skip_onboarding' });
      }
    }

    // The session may have grown old at the desk prompt (the server drops one that has not said
    // hello for 10 minutes): make it, and its voices, again before hello rather than greet into
    // a dropped session.
    let voices = this.voicesStarting ?? this.connectVoices();
    if (this.unstarted()) {
      await voices.catch(() => undefined);
      await this.panel?.stopAll();
      if (this.disposed || this.st !== 'placing') return;
      voices = this.connectVoices();
    }

    // The start chime plays now, with every mic still closed. The opening is asked for meanwhile
    // (its first word is more than a chime away); the mic opens when the chime is over.
    this.micHeld = true;
    const cue = (xr.startCue?.().catch(() => undefined) ?? Promise.resolve()).then(() => {
      this.micHeld = false;
    });

    this.setState('greeting');
    try {
      await voices;
    } catch (err) {
      await this.panel?.stopAll();
      this.voicesStarting = null;
      this.releaseMic();
      // No voice, no round: the room never says hello, so nothing starts or counts on the server.
      this.closeSocket();
      const e = err instanceof VoiceError ? err : new VoiceError('connect_failed', String((err as Error)?.message ?? err), err);
      if (!this.disposed && isActive(this.st)) {
        this.setState('failed');
        this.emitError(e);
        // The way on ("Try again") is on the page: leave the headset view so it shows. Never
        // leave the user in the room with nothing to press.
        xr.exit?.();
      } else {
        this.emitError(e);
      }
      throw e;
    }
    // Only now, with the desk placed and the voices up, does the room say hello: the server's
    // round clock and the round's count toward limits start here, not at the mic tap, and never
    // for a round whose voice did not make it.
    this.socketWanted = true;
    await this.connectSocket();
    this.releaseMic(); // the voice service holds its own capture now
    const panel = this.panel;
    // Ended, failed or disposed while the voices were connecting: the panel stopped them.
    if (this.disposed || !panel || panel.isStopped || !isActive(this.st)) return;

    this.voicesUp = true;
    const head = this.deps.head;
    if (head) {
      head.setFloor(panel.floor);
      head.start((samples) => this.socket?.send('head.samples', { samples }));
    }
    // The opening marker is a typed turn: it needs no mic, so it goes out at once.
    if (this.st === 'paused') this.startPending = true; // greet once the user is back
    else this.sendStart();

    await cue;
    // Paused meanwhile: everyone stays muted until Resume. Ended or closed: nothing to open.
    if (this.disposed || panel.isStopped) return;
    this.openMic();
  }

  /** Starts connecting the voices (once); a failure is reported after placement. */
  private connectVoices(): Promise<void> {
    const starting = this.startVoices().then(() => void this.deps.timings?.mark('voices_connected'));
    starting.catch(() => undefined);
    this.voicesStarting = starting;
    return starting;
  }

  /** True when the session has waited so long without a hello that the server is about to drop it. */
  private unstarted(): boolean {
    return this.input?.kind !== 'resume' && !this.helloSent && Date.now() - this.sessionAt > UNSTARTED_SESSION_MS;
  }

  /** Opens the mic to the floor, unless the user muted it, the round is paused or the start chime still plays. */
  private openMic(): void {
    if (this.micHeld || (this.st !== 'greeting' && this.st !== 'live')) return;
    void this.panel?.muteAll(this.userMuted);
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
    // The tap on the page's Resume was the user's decision: the round carries on once the desk is down.
    if (!this.disposed && this.st === 'paused') this.resume();
  }

  /** Brings the panel's voices up; a voice token that ran out is replaced by making the session again. */
  private async startVoices(): Promise<void> {
    let res = this.res!;
    if (this.sessionStale(res)) res = await this.renewSession();
    for (;;) {
      const panel = this.makePanel(res);
      this.panel = panel;
      try {
        // Nobody hears the user before the opening has been asked for and the chime is over:
        // every voice joins with its mic closed, also one that joins after the desk is down.
        void panel.muteAll(true);
        await panel.start();
        return;
      } catch (err) {
        await panel.stopAll();
        const expired = (err as VoiceError)?.code === 'session_expired';
        if (!expired || this.renewed || this.disposed || this.st === 'failed') throw err;
        res = await this.renewSession();
      }
    }
  }

  private makePanel(res: CreateSessionRes): PanelController {
    return new PanelController(res, (p, o) => this.wire(this.deps.makeTransport(p, o, this.res ?? res)), {
      api: this.deps.api,
      waitQuiet: (t, expectSpeech) => this.waitQuiet(t, expectSpeech),
      // A hand-over caught by a pause waits for Resume: nobody new speaks while the user is away.
      ready: () => this.unpaused(),
    });
  }

  /** Resolves at once unless the round is paused; then on Resume (or when the round ends). */
  private unpaused(): Promise<void> {
    if (this.st !== 'paused') return Promise.resolve();
    this.gatedHandOver = this.flight[0] ?? null;
    return new Promise<void>((r) => this.pauseWaiters.push(r));
  }

  private releasePause(): void {
    for (const r of this.pauseWaiters.splice(0)) r();
  }

  /**
   * True when the session made at the mic tap can no longer be started: its voice token is past
   * its join deadline, or the server is about to drop it for never having said hello (10 minutes).
   * A resumed round said hello at the mic tap and is not dropped that way.
   */
  private sessionStale(res: CreateSessionRes): boolean {
    if (this.input?.kind !== 'resume' && Date.now() - this.sessionAt > UNSTARTED_SESSION_MS) return true;
    return this.tokenStale(res);
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
    this.sessionAt = Date.now();
    this.applyTiming(res);
    // The earlier session's socket goes first, listeners and all: it must never say hello.
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
    if (this.st === 'paused') return; // the sheet stays usable; nothing of it reaches the voice
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
    if (muted) {
      if (this.st !== 'paused') void this.panel?.muteAll(true);
    } else this.openMic();
  }

  /**
   * Pauses the round, in any active state: the mic closes at once, the interviewer stops
   * mid-word, an open user segment is dropped, the avatars sit and listen. Nothing resumes by
   * itself. Before the round began (placing) and after it (ending, scoring) this does nothing.
   */
  pause(reason: PauseReason = 'user'): void {
    if (this.st !== 'live' && this.st !== 'greeting') return;
    this.setState('paused');
    this.away = reason !== 'user' && reason !== 'voice_lost';
    this.cameBack = false;
    // A swap under way is held by this pause wherever it is (joining, or waiting for the outgoing voice): its new
    // voice says nothing until Resume, and its line is then the welcome back.
    if (this.panel?.isSwapping) this.gatedHandOver ??= this.flight[0] ?? null;
    void this.panel?.muteAll(true);
    for (const t of this.panel?.all() ?? []) t.interrupt?.();
    this.socket?.send('ui.event', { kind: 'pause', reason });
    this.clearTimers();
    this.clearWatchdog();
    this.dropOpenSpeech();
    this.endLongAnswerMute();
    this.flushSpoken();
    for (const p of this.res?.panel ?? []) this.deps.avatars?.(p.panelist_id)?.setMode('listening');
    const { xr } = this.deps;
    if (reason !== 'voice_lost') xr.cue?.('pause');
    xr.ui.setPaused?.(true);
    this.syncNotice();
  }

  /**
   * The user's Resume (never called by a return of visibility). Under 45 s the same voices open
   * again; after a voice release (or a lost voice) new ones are made first.
   */
  resume(): void {
    if (this.st !== 'paused' || this.resuming) return;
    this.away = false;
    const panel = this.panel;
    const gone = this.voicesGone || this.lastRound?.voices_released === true || (!!panel && this.voicesUp && (panel.isStopped || !panel.current()));
    if (gone) {
      this.holdOver = false;
      this.resuming = this.reconnect().finally(() => {
        this.resuming = null;
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = null;
        this.syncNotice();
      });
      // Still not back after a while: the card with Resume and End shows while the try goes on.
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.holdOver = true;
        this.syncNotice();
      }, VOICE_HOLD_MS);
      this.syncNotice();
      return;
    }
    this.finishResume(this.rebuilt);
  }

  /**
   * New voices for a round whose voices are gone: `POST /resume` (not counted for a paused round),
   * the room socket again under the new token, the panel again. The round clock stays stopped on
   * the server until the interviewer is asked to welcome the user back.
   */
  private async reconnect(): Promise<void> {
    const id = this.res!.session_id;
    const old = this.panel;
    let res: CreateSessionRes;
    try {
      res = await this.deps.api.resumeSession(id);
    } catch (err) {
      if (this.disposed || this.st !== 'paused') return;
      if (RESUME_GONE.has((err as ApiError)?.code)) return this.roundEndedPaused();
      this.emitError(err as ApiError);
      this.voiceLost = true;
      return;
    }
    if (this.disposed || this.st !== 'paused') return;
    await old?.stopAll();
    // Ended or closed while the old voices stopped: nothing new is opened.
    if (this.disposed || this.st !== 'paused') return;
    this.modes.clear();
    // The new voices number their replies from the start again: their keys carry the voice's own number, so
    // nothing of the old ones is mistaken for them (a reply is reported as played once per voice and segment).
    this.spokenSent.clear();
    this.spokenPending = null;
    this.lastAgentSegment = null;
    this.res = res;
    this.preparedRes = res;
    this.applyTiming(res);
    if (this.lastRound) this.lastRound = { ...this.lastRound, voices_released: false };
    // The new socket picks up where the old one was: the server must not replay the whole round
    // (old hand-overs among it) into the page.
    const seen = this.socket?.lastSeq?.() ?? 0;
    this.closeSocket();
    this.openSocket(res, seen);
    this.socketWanted = true;
    this.events.emit('session', res);
    const panel = this.makePanel(res);
    this.panel = panel;
    try {
      void panel.muteAll(true);
      await Promise.all([panel.start(), this.connectSocket()]);
    } catch (err) {
      await panel.stopAll();
      if (this.disposed || this.st !== 'paused') return;
      // Not the end of the round: the card offers Resume again.
      this.emitError(new VoiceError('voice_lost', String((err as Error)?.message ?? err), err));
      this.voicesGone = true;
      this.voiceLost = true;
      return;
    }
    if (this.disposed || panel.isStopped || this.st !== 'paused') {
      // Ended or closed while the new voices joined: they are stopped again.
      if (!panel.isStopped) await panel.stopAll();
      return;
    }
    this.voicesGone = false;
    this.voiceLost = false;
    this.voicesUp = true;
    this.rebuilt = true;
    this.deps.head?.setFloor(panel.floor);
    // The user went away while the voices were made: the round stays held, with its voices, until
    // their Resume. The server took the round out of its pause for the new voices: it is told to
    // hold it again, so the voices are released like in any pause.
    if (this.away) {
      this.socket?.send('ui.event', { kind: 'pause', reason: 'headset_removed' });
      return;
    }
    this.finishResume(true);
  }

  /** The round runs again: tone, mic, and the interviewer (or the panelist taking over) welcomes the user back. */
  private finishResume(reconnected: boolean): void {
    const { xr } = this.deps;
    this.voiceLost = false;
    this.cameBack = false;
    xr.ui.setPaused?.(false);
    xr.cue?.('resume');
    this.socket?.send('ui.event', { kind: 'resume' });
    this.setState(this.greeted ? 'live' : 'greeting');
    this.openMic();
    this.rebuilt = false;
    const gated = this.gatedHandOver;
    this.gatedHandOver = null;
    this.releasePause();
    const floor = this.panel?.floor;
    // A hand-over to the panelist who already holds the floor is done (the server moved the floor
    // when the hand-over was said, and new voices are made for the floor it has).
    const pending = this.pendingHandOver;
    const handOver = pending && pending.to !== floor ? pending : null;
    // New voices were made for a panelist whose hand-over this page only heard of during the pause
    // (or held): its line was never said, and the server keeps it for `[event: handover]`.
    const unsaid = reconnected && ((!!pending && pending.to === floor) || (!!gated && gated.to === floor));
    this.pendingHandOver = null;
    if (this.startPending) {
      this.startPending = false;
      this.sendStart();
    } else if (handOver) {
      // The new panelist's opening line is the welcome back (if the hand-over fails, the floor's is).
      this.welcomeBackBy = this.handOver(handOver.to);
    } else if (gated && !reconnected) {
      // The hand-over that waited goes on by itself: its opening line is the welcome back (and if it fails, the
      // floor welcomes the user back instead).
      this.welcomeBackBy = gated;
    } else if (gated && gated.to !== floor) {
      // The voices were made again meanwhile: the hand-over runs on the new panel.
      this.welcomeBackBy = this.handOver(gated.to);
    } else if (unsaid && this.voicesUp) {
      // The new voices are already the new panelist's: it says its line now.
      this.floorT()?.sendEvent(VOICE_MARKERS.handover);
    } else if (this.voicesUp) {
      this.floorT()?.sendEvent(VOICE_MARKERS.resume);
      // Still not greeted: keep offering "Tap to hear" if the voice stays silent.
      if (!this.greeted) this.armWatchdog();
    }
    this.flushTimeCheck();
    this.syncNotice();
  }

  /** Visibility of the headset session, or of the page: away pauses, back only changes the card. */
  private onVisibility(v: XRVisibilityLike | 'page-hidden'): void {
    if (v === 'visible') {
      if (this.st !== 'paused' || !this.away) return;
      this.away = false;
      this.cameBack = true;
      this.syncNotice();
      return;
    }
    this.pause(v === 'hidden' ? 'headset_removed' : v === 'page-hidden' ? 'hidden' : 'blurred');
    if (this.st === 'paused') {
      this.away = true;
      this.cameBack = false;
    }
  }

  /** The pause budget ran out (or the round ended) while the user was away. */
  private roundEndedPaused(): void {
    this.endedPaused = true;
    this.onRoundEnded();
    this.syncNotice();
  }

  /** Which card the current state calls for, most pressing first. */
  private currentNotice(): NoticeKind | null {
    if (this.st === 'paused') {
      if (this.resuming && !this.holdOver) return 'reconnecting';
      if (this.voiceLost || (this.resuming && this.holdOver)) return 'lost';
      return this.cameBack ? 'welcome_back' : 'paused';
    }
    if (this.st === 'scoring' || this.st === 'ending') {
      if (this.cardShown) return null;
      if (this.endedPaused) return 'ended_paused';
      return this.scoringSlow && this.st === 'scoring' ? 'scoring_slow' : null;
    }
    if (this.st === 'live' || this.st === 'greeting') {
      if (this.socketDown) return 'socket';
      if (this.degraded) return 'degraded';
    }
    return null;
  }

  private syncNotice(): void {
    if (this.disposed) return;
    const n = this.currentNotice();
    if (n === this.shownNotice) return;
    const was = this.shownNotice;
    this.shownNotice = n;
    const ui = this.deps.xr.ui;
    if (ui.setNotice) ui.setNotice(n);
    else ui.setStatus(n ? NOTICES[n].title : null);
    // The plain scoring line comes back when a card over it goes away.
    if (!n && was && this.st === 'scoring' && !this.cardShown) ui.setStatus('Writing your scorecard', this.scoringPct);
    this.events.emit('notice', n);
  }

  /** Ends the round: the interviewer says goodbye, then the round is scored. */
  end(reason: EndReason = 'user_ended'): void {
    // Before the round began (still placing the desk, or never entered): nothing to score.
    if (this.st === 'placing' || (this.st === 'idle' && this.res)) return void this.cancel();
    if (!isActive(this.st)) return;
    // From a pause nobody can say goodbye (the round is held, the voices may be gone): end it at once.
    if (this.st === 'paused') return this.beginEnding(reason, false, true);
    this.socket?.send('ui.event', { kind: 'end' });
    this.beginEnding(reason);
  }

  /** Ends a round that never began: the voices stop and the room never says hello to the server. */
  private async cancel(): Promise<void> {
    this.releasePause();
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
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.releasePause();
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

  private openSocket(res: CreateSessionRes, lastSeq = 0): void {
    const s = this.deps.makeSocket(res.ws_url, res.client_token, lastSeq);
    this.socket = s;
    this.socketUp = null;
    this.socketTerminal = false;
    this.socketUnsubs.push(
      s.on('round.state', (d) => this.onRoundState(d)),
      // The opening line is the server's to say (on `[event: handover]`): the page only moves the floor.
      s.on('panel.hand_over', (d) => this.handOver(d.to)),
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
          // New voices are being made: the server closes the earlier token's socket (4401) as it
          // hands out the new one. The new socket is on its way.
          if (this.resuming && info.code === 4401) return;
          this.socketTerminal = true;
          // After the round the server closes the room for good once the report is done (or late).
          if (this.st === 'summary') return;
          // The round ended while this page was not listening (a long pause with the socket down).
          if (info.code === 4409 && isActive(this.st)) this.onRoundEnded();
          if (this.st === 'scoring' || (this.serverEnded && this.st === 'ending')) {
            void this.showReport(true);
            return;
          }
          this.emitError(new SessionError('socket_terminal', `The room connection closed (${info.code})`, info));
          // The way on is on the page: leave the headset view so it shows.
          this.deps.xr.exit?.();
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
    this.helloSent = true;
    this.socketUp ??= s
      .connect()
      .then(() => {
        // The typed-turn voice posts straight to our own endpoint, which serves a round only once
        // the server has taken the hello: wait for its first frame. A real voice takes longer to
        // reach us than the hello does, so it never waits here.
        const heard = this.req?.voice === 'fake' ? s.heard?.() : undefined;
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
      this.socketDropped = true;
      // A blip passes unseen; a real drop shows the banner, and later a typed error.
      this.bannerTimer ??= setTimeout(() => {
        this.bannerTimer = null;
        if (this.disposed || this.socketTerminal) return;
        this.socketDown = true;
        this.syncNotice();
      }, RECONNECT_BANNER_MS);
      this.reconnectTimer ??= setTimeout(() => {
        this.reconnectTimer = null;
        if (this.disposed || this.socketTerminal) return;
        this.emitError(new SessionError('socket_failed', 'Reconnecting to the room'));
      }, RECONNECT_WARN_MS);
      return;
    }
    if (st !== 'open') return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.reconnectTimer = null;
    this.bannerTimer = null;
    this.socketDown = false;
    if (this.socketDropped) {
      this.socketDropped = false;
      // The server stopped the round clock at the drop and a reconnect alone does not start it
      // again: say the user is here. A paused round stays paused.
      if (this.st === 'live' || this.st === 'greeting') this.socket?.send('ui.event', { kind: 'resume' });
    }
    this.syncNotice();
  }

  private watchPage(): void {
    const v = this.deps.visibility;
    if (v) {
      const onVis = () => this.onVisibility(v.visibilityState === 'hidden' ? 'page-hidden' : 'visible');
      v.addEventListener('visibilitychange', onVis);
      this.unsubs.push(() => v.removeEventListener('visibilitychange', onVis));
    }
    const board = this.deps.board;
    if (board) this.unsubs.push(board.onActivity(() => this.noteUserActivity()));
    this.unsubs.push(this.deps.xr.ui.onAction((a) => this.onAction(a)));
    const { xr } = this.deps;
    if (xr.onVisibility) this.unsubs.push(xr.onVisibility((vis) => this.onVisibility(vis)));
    // The system took the headset view away mid round (asleep, the user's exit): the round is
    // held, and the page offers the way back.
    if (xr.onSessionEnd) this.unsubs.push(xr.onSessionEnd(({ byApp }) => !byApp && this.onVisibility('visible-blurred')));
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
        return this.pause('user');
      case 'resume':
        return this.resume();
      case 'end':
        return this.end();
      case 'hear':
        return this.hearAgain();
      case 'stay':
        // Waiting here: the offer goes away and does not come back.
        this.scoringSlow = false;
        return this.syncNotice();
      case 'retry':
      case 'report':
      case 'history':
        return this.events.emit('action', a);
      case 'skip':
        return; // the onboarding's Skip: the room's own (session/runtime.ts)
    }
  }

  private wire(t: VoiceTransport): VoiceTransport {
    const gen = ++this.transportSeq;
    this.voiceNo.set(t, gen);
    t.on('mode', (m) => this.onMode(t, m));
    t.on('userTranscript', (e) => this.onUser(t, gen, e));
    t.on('agentText', (e) => this.onAgentText(t, e));
    t.on('ended', (e) => this.onEnded(t, e.reason));
    t.on('error', (e) => this.onVoiceError(t, e));
    return t;
  }

  /**
   * A voice that does not hold the floor (one joining in a swap, or one on its way out) cannot lose the round: its
   * error is reported as a hand-over that did not happen, never as the round's end. In joined mode every voice is
   * connected and only the floor's errors count as the round's.
   */
  private onVoiceError(t: VoiceTransport, e: VoiceError): void {
    const panel = this.panel;
    const floor = !!panel && !panel.isStopped && panel.current() === t;
    if (floor || !panel) return this.emitError(e);
    this.emitError(new VoiceError('handover_failed', e.message, e));
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

  /**
   * The server moved the floor. Swap mode joins the new voice at once (it connects muted and silent
   * while the outgoing panelist finishes its sentence) and switches when that voice is quiet. A swap
   * that fails leaves the old voice on the floor; the server's next hand-over to the same panelist
   * tries again. Returns the hand-over under way, if one started.
   */
  private handOver(to: string): { to: string } | null {
    // Already on the floor while the round runs: nothing to do. (During a pause it is kept: Resume decides.)
    if (this.st !== 'paused' && this.panel && !this.panel.isStopped && this.voicesUp && to === this.panel.floor && !this.handingOver) return null;
    if (this.st === 'paused' || this.st === 'greeting') {
      // Nobody new joins while the user is away, and nobody takes over before the greeting is
      // done (a swap during the greeting would greet twice). Replayed on Resume or once live.
      this.pendingHandOver = { to };
      return null;
    }
    if (this.st !== 'live') return null;
    const panel = this.panel;
    if (!panel || panel.isStopped) return null;
    this.handingOver++;
    const flying = { to };
    this.flight.push(flying);
    this.clearTimers();
    this.resetUserSpeech();
    panel
      .handOver(to)
      .then(() => {
        if (this.welcomeBackBy === flying) this.welcomeBackBy = null;
        const live = new Set(panel.all());
        for (const t of [...this.modes.keys()]) if (!live.has(t)) this.modes.delete(t);
        if (panel.isStopped) return;
        this.deps.head?.setFloor(panel.floor);
        // The pause came after the new voice was already joining: it keeps quiet until Resume.
        if (this.st === 'paused') panel.current()?.interrupt?.();
      })
      .catch((err) => {
        // A voice set that was replaced meanwhile (new voices after a pause) is not a failure.
        if (panel !== this.panel || panel.isStopped) return;
        // Failed during a pause (the voices may be released meanwhile): Resume tries it again, or the
        // voices made for the server's floor say its line.
        if (this.st === 'paused') {
          this.pendingHandOver ??= { to };
          return;
        }
        // The old voice keeps the floor and hears the user again; the server asks again on its next hand-over. Not the
        // end of the round, so not shown as one.
        if (this.st === 'live') this.emitError(new VoiceError('handover_failed', String((err as Error)?.message ?? err), err));
        // The swap Resume let go was to be the welcome back: the floor says it instead, so the room is never silent.
        if (this.welcomeBackBy === flying) {
          this.welcomeBackBy = null;
          if (this.st === 'live') this.floorT()?.sendEvent(VOICE_MARKERS.resume);
        }
      })
      .finally(() => {
        const i = this.flight.indexOf(flying);
        if (i >= 0) this.flight.splice(i, 1);
        this.handingOver--;
        this.rearmSilence();
        this.flushTimeCheck();
      });
    return flying;
  }

  /**
   * Resolves once the voice has said what it is saying or about to say, so a hand-over never cuts a sentence or a
   * line before it is heard: at once when it is quiet with nothing on its way; while it is thinking (or
   * `expectSpeech`: it was just asked for its opening line) first for its speech to start (HANDOFF_START_MS at most),
   * then for it to end (HANDOFF_WAIT_MS at most once it speaks). A voice that ends counts as quiet.
   */
  private waitQuiet(t: VoiceTransport, expectSpeech = false): Promise<void> {
    const now = this.modes.get(t);
    if (!expectSpeech && now !== 'speaking' && now !== 'thinking') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let set = this.quietWaiters.get(t);
      if (!set) this.quietWaiters.set(t, (set = new Set()));
      let speaking = now === 'speaking';
      let thought = now === 'thinking';
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        set.delete(watch);
        resolve();
      };
      const watch = (m: VoiceMode | 'ended') => {
        if (m === 'ended') return done();
        if (m === 'speaking') {
          if (speaking) return;
          speaking = true;
          clearTimeout(timer);
          timer = setTimeout(done, HANDOFF_WAIT_MS);
          return;
        }
        if (m === 'thinking') {
          thought = true;
          return;
        }
        // Back to listening: the sentence is over, or the reply it was thinking of came to nothing.
        if (speaking || thought) done();
      };
      timer = setTimeout(done, speaking ? HANDOFF_WAIT_MS : HANDOFF_START_MS);
      set.add(watch);
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
    for (const watch of [...(this.quietWaiters.get(t) ?? [])]) watch(m);
    const avatar = this.deps.avatars?.(t.panelistId);
    // Paused: everyone sits and listens, whatever a voice still reports.
    avatar?.setMode(this.st === 'paused' ? 'listening' : m);
    // A reply that was already on its way when the pause landed: it does not play into the pause.
    if (this.st === 'paused' && (m === 'thinking' || m === 'speaking')) t.interrupt?.();
    if (m === 'speaking' && avatar && this.st !== 'paused') {
      const stream = t.outputStream();
      if (stream && this.voices.get(t.panelistId) !== stream) {
        this.voices.set(t.panelistId, stream);
        avatar.attachVoice(stream);
      }
    }
    if (m === 'thinking') this.latency.thinking(now);
    if (m === 'thinking' || m === 'speaking') {
      this.sawAgent = true;
      if (!this.longAnswerMuted) {
        // nothing held
      } else if (m === 'thinking') {
        // The interviewer is answering the marker: keep the mic closed until the cut-in is heard (bounded).
        this.holdLongAnswerMute(LONG_ANSWER_MAX_MUTE_MS);
      } else {
        // The cut-in is playing: the mic opens once its first words are out.
        this.holdLongAnswerMute(LONG_ANSWER_CUT_IN_MS);
      }
    }
    // The reply is over: report a short one that never reached the usual length.
    if (m !== 'speaking' && this.spokenPending?.panelistId === t.panelistId) this.flushSpoken();
    if (m !== 'speaking' && this.agentSpeakingSince !== null) {
      if (this.cand) {
        this.cand.agentLongest = Math.max(this.cand.agentLongest, now - this.agentSpeakingSince);
        // Played to its end, however short ("Why?"): the candidate's turn was answered.
        if (t === this.floorT() && !this.userSpeaking && endsSentence(this.agentSaid)) this.cand.answered = true;
      }
      this.agentSpeakingSince = null;
    }
    if (m === 'speaking') {
      this.deps.timings?.mark('first_audio');
      // Whether the agent answered (and the candidate's turn is over) shows when the candidate speaks next: a start
      // that their words cut off at once does not count (trackTurn).
      this.agentSpeakingSince ??= now;
      this.silenceFired = false;
      if (this.st !== 'paused') this.greeted = true;
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
    if (this.st === 'paused') {
      // Speech that reaches us during a pause (a segment that was open when it began) is dropped whole.
      this.marked.add(key);
      return;
    }
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
    if (t === this.floorT()) this.agentSaid = e.text;
    const split = this.latency.agentText(Date.now(), e.segmentId);
    if (split) this.events.emit('latency', split);
    this.noteSpoken(t, e);
    this.events.emit('transcript', {
      panelistId: t.panelistId,
      role: 'agent',
      segmentId: this.agentKey(t, e.segmentId),
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
    this.handOver(h.to);
  }

  /**
   * `voice.spoken`: the first words of a reply as they played, once per reply. Sent as soon as
   * enough has played, so the server's actions for the reply land while it is being said.
   */
  private noteSpoken(t: VoiceTransport, e: AgentText): void {
    const key = this.agentKey(t, e.segmentId);
    if (this.spokenSent.has(key)) return;
    if (this.spokenPending && this.spokenPending.key !== key) this.flushSpoken();
    this.spokenPending = { key, panelistId: t.panelistId, text: e.text };
    if (e.text.trim().length >= SPOKEN_MIN_CHARS) this.flushSpoken();
  }

  /**
   * One reply of one voice: panelist, the voice it came from, segment. A panelist who gets the floor back has a
   * new voice whose segment ids start again (the typed-turn voice counts from 1), and a reconnect makes new voices
   * too: their replies must never be taken for earlier ones (the transcript would overwrite those lines, and
   * `voice.spoken` would never go out for them, so the server would not know they played).
   */
  private agentKey(t: VoiceTransport, segmentId: string): string {
    return `${t.panelistId}.${this.voiceNo.get(t) ?? 0}.${segmentId}`;
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
    // The floor's voice ended on its own before the round began (the user was away from the desk
    // prompt for minutes): drop the panel, so the next enter() connects again instead of greeting
    // through a dead voice.
    const panel = this.panel;
    if (!this.voicesUp && panel && !panel.isStopped && panel.current() === t && (this.st === 'placing' || this.st === 'idle')) {
      this.voicesStarting = null;
      void panel.stopAll();
      return;
    }
    for (const watch of [...(this.quietWaiters.get(t) ?? [])]) watch('ended');
    if (this.floorT() !== t || this.finishing) return;
    // During a pause the server releases the voices after 45 s: Resume makes new ones.
    if (this.st === 'paused') {
      this.voicesGone = true;
      return;
    }
    // Transports we stop (hand-over, round end) are not the floor any more by then; a floor that
    // ends mid hand-over is being replaced.
    if (this.handingOver) return;
    if (this.st !== 'live' && this.st !== 'greeting') return;
    // The voice dropped mid round: hold the round and get a new one. The user sees one calm line;
    // if that fails, a card with Resume and End.
    this.emitError(new VoiceError('voice_lost', `The voice connection ended (${reason})`));
    this.voicesGone = true;
    this.pause('voice_lost');
    this.resume();
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

  /** A pause cuts the user off: what was being said is dropped, and never sent later as a transcript. */
  private dropOpenSpeech(): void {
    for (const key of this.segments.keys()) this.marked.add(key);
    this.resetUserSpeech();
  }

  private resetUserSpeech(): void {
    this.segments.clear();
    if (this.cand) this.cand.inSegment = false; // that segment is over, so is its turn's run
    if (this.userSpeaking) this.setUserSpeaking(false);
  }

  // ---------- long answers ----------

  private trackTurn(now: number, final: boolean): void {
    let c = this.cand;
    // Whatever the interviewer plays after these words belongs to its next reply.
    this.agentSaid = '';
    const longest = Math.max(c?.agentLongest ?? 0, this.agentSpeakingSince !== null ? now - this.agentSpeakingSince : 0);
    if (!c || (!c.inSegment && (now - c.lastFinal >= TURN_GAP_MS || c.answered || longest >= AGENT_REPLY_MS))) {
      c = { start: now, lastFinal: now, inSegment: false, sent: false, agentLongest: 0, answered: false };
      // A reply still playing as the candidate starts again counts toward this turn only from here.
      if (this.agentSpeakingSince !== null) this.agentSpeakingSince = now;
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
    // A turn the interviewer answered is over, even within the gap that would otherwise join two segments.
    const answered = c.answered || c.agentLongest >= AGENT_REPLY_MS;
    const ongoing = !answered && (c.inSegment || now - c.lastFinal < TURN_GAP_MS);
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
        // From the marker on, the mic stays closed this long at most, whatever the voice reports.
        this.longAnswerDeadline = Date.now() + LONG_ANSWER_MAX_MUTE_MS;
      }
    } catch {
      // the mute failed: no marker, and the mic is opened again below
    } finally {
      if (!this.longAnswerMuted) {
        // already opened again (the agent took the turn meanwhile)
      } else if (sent) {
        this.holdLongAnswerMute(LONG_ANSWER_MUTE_MS);
      } else {
        this.endLongAnswerMute();
      }
    }
  }

  /** Keeps the long-answer mute on for `ms` more, never past its deadline from the marker. */
  private holdLongAnswerMute(ms: number): void {
    if (this.longAnswerUnmute) clearTimeout(this.longAnswerUnmute);
    const left = this.longAnswerDeadline ? this.longAnswerDeadline - Date.now() : ms;
    this.longAnswerUnmute = setTimeout(() => this.endLongAnswerMute(), Math.max(0, Math.min(ms, left)));
  }

  private endLongAnswerMute(): void {
    if (!this.longAnswerMuted) return;
    this.longAnswerMuted = false;
    this.longAnswerDeadline = 0;
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
      !this.degraded &&
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
    // The server says the round is over (its own goodbye at a time limit, a retry's fixed end):
    // the same as round.ended, and never a request for another goodbye from here.
    if (ROUND_OVER.has(d.status) && (isActive(this.st) || this.st === 'ending') && !this.serverEnded) this.onRoundEnded();
    this.deps.xr.ui.setRoundState({ ...d, controller: this.st });
    // The interviewer's model is failing and the server holds the clock: one calm line until a real reply.
    if (!!d.degraded !== this.degraded) {
      this.degraded = !!d.degraded;
      this.syncNotice();
      if (!this.degraded) this.rearmSilence();
    }
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
  private beginEnding(reason: EndReason | null, ask = true, now = false): void {
    if (!isActive(this.st)) return;
    const wasPaused = this.st === 'paused';
    this.endReason = reason;
    this.endingSawSpeech = false;
    this.pendingHandOver = null;
    this.gatedHandOver = null;
    // A swap under way is called off: the outgoing panelist keeps the floor and says the goodbye.
    this.panel?.cancelHandOvers();
    this.clearTimers();
    this.clearWatchdog();
    this.endLongAnswerMute();
    this.deps.board?.roundEnding?.();
    this.setState('ending');
    if (wasPaused) this.deps.xr.ui.setPaused?.(false);
    this.releasePause();
    this.syncNotice();
    if (!this.voicesUp || now) {
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
    // Ended during a pause: the budget for pauses ran out. The user is told so when they are back.
    if (this.st === 'paused') this.endedPaused = true;
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
      if (!this.cardShown && !this.endedPaused) this.deps.xr.ui.setStatus('Writing your scorecard', 0);
      this.syncNotice();
      // A report that takes a minute: offer the way to History instead of a long wait.
      this.slowTimer = setTimeout(() => {
        this.slowTimer = null;
        if (this.st !== 'scoring' || this.cardShown || this.disposed) return;
        this.scoringSlow = true;
        this.syncNotice();
      }, SCORING_SLOW_MS);
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
      this.syncNotice();
      ui.setStatus(null);
      ui.showCard(d.card);
      return;
    }
    // Once the card is up it stays; the summary replaces it when the report is ready.
    this.scoringPct = Math.max(0, Math.min(1, d.pct / 100));
    if (!this.cardShown && !this.shownNotice) ui.setStatus('Writing your scorecard', this.scoringPct);
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
      this.cardShown = true;
      this.syncNotice(); // this card replaces any notice that was up
      ui.setStatus(null);
      if (ui.showCard) ui.showCard({ one_line: 'Taking longer than usual. See the full report.', top_strength: null, top_fix: null }, { pending: false });
      else ui.setStatus('Scorecard taking longer than usual');
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
    if (s === 'summary' || s === 'failed') {
      if (this.slowTimer) clearTimeout(this.slowTimer);
      this.slowTimer = null;
      this.syncNotice();
    }
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
