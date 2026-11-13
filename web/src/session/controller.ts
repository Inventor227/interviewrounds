// RoundController: the client-side state machine of one round.
//
//   idle → placing → greeting → live ⇄ paused → ending → scoring → summary
//
// It ties together the session socket, the panel of voice transports, the XR app, the avatars,
// the head sampler and the board, and owns the browser's side of the conversation rules:
// - Start (inside the user's Start click): mic → AudioContext.resume() → create session →
//   enter XR → desk placement → voices up → `[event: start]`.
// - `[event: silence_check]` once per silence: nobody speaking and no board activity for the
//   round's silence_wait_seconds.
// - `[event: long_answer]` once per candidate turn (segments with gaps under 1.2 s merge into
//   one turn) that runs past interrupt_after_seconds; interviews only, never over the agent.
// - `[event: time_check]` when the server moves to the next phase on time.
// - `transcript.mark` once per final user segment; `voice.state` on every mode change, carrying
//   the latest finished latency split.
// - Auto-pause when the page is hidden (headset off).

import type { ApiError } from '../net/api';
import {
  VOICE_MARKERS,
  type ClientMsgMap,
  type CreateSessionReq,
  type CreateSessionRes,
  type EndReason,
  type Panelist,
  type RoundStatePayload,
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

/** Sent when one candidate turn runs past interrupt_after_seconds (docs/protocol.md). */
export const LONG_ANSWER_MARKER = '[event: long_answer]';
/** Segments closer than this belong to the same candidate turn. */
export const TURN_GAP_MS = 1200;
/** Longest wait for the goodbye line before the round is closed anyway. */
export const ENDING_GRACE_MS = 15_000;
/** A phase change counts as "on time" when the old phase had at most this much left. */
const PHASE_TIME_SLACK_S = 5;

export type SessionErrorCode = 'xr_enter_failed' | 'placement_failed' | 'already_started';
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

export interface TranscriptLine {
  panelistId: string;
  role: 'user' | 'agent';
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
}

interface CandidateTurn {
  start: number;
  lastFinal: number;
  inSegment: boolean;
  sent: boolean;
}

type VoiceStateMsg = ClientMsgMap['voice.state'] & { latency?: LatencySplit };

export class RoundController {
  private readonly events = new Emitter<ControllerEvents>();
  private readonly timing: RoundTiming;
  private readonly latency = new LatencyTracker();
  private readonly unsubs: (() => void)[] = [];

  private st: ControllerState = 'idle';
  private req: CreateSessionReq | null = null;
  private res: CreateSessionRes | null = null;
  private socket: SocketPort | null = null;
  private panel: PanelController | null = null;
  private preMic: MediaStream | null = null;

  // voices
  private transportSeq = 0;
  private readonly modes = new Map<VoiceTransport, VoiceMode>();
  private readonly voices = new Map<string, MediaStream>();
  private greeted = false;
  private userMuted = false;

  // user speech
  private readonly segments = new Map<string, number>();
  private readonly marked = new Set<string>();
  private userSpeaking = false;
  private cand: CandidateTurn | null = null;
  private candTimer: ReturnType<typeof setTimeout> | null = null;

  // silence
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceFired = false;

  // round state from the server
  private lastRound: RoundStatePayload | null = null;

  // ending
  private endReason: EndReason | null = null;
  private endingSawSpeech = false;
  private endingTimer: ReturnType<typeof setTimeout> | null = null;
  private finishing: Promise<void> | null = null;

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
   * Starts a round. Call it from the Start click: the mic prompt and entering XR both need the
   * user's gesture, and Quest Browser cannot ask for the mic once immersive.
   */
  async start(req: CreateSessionReq): Promise<void> {
    if (this.st !== 'idle' || this.req) throw new SessionError('already_started', 'This round has already started');
    this.req = req;
    const { media, api } = this.deps;

    try {
      this.preMic = await media.getMic();
    } catch (err) {
      const e = micError(err);
      if (req.voice === 'fish') {
        this.req = null;
        this.emitError(e);
        throw e;
      }
      // Typed turns work without a mic.
    }
    await media.resumeAudio().catch(() => undefined);

    let res: CreateSessionRes;
    try {
      res = await api.createSession(req);
    } catch (err) {
      this.releaseMic();
      this.req = null;
      this.emitError(err as ApiError);
      throw err;
    }
    this.res = res;
    this.openSocket(res);
    this.watchPage();
    await this.enter();
  }

  /**
   * Enters XR, waits for desk placement and brings the voices up. start() calls it; call it
   * again from a new tap when entering failed (for example, the user took too long on the mic
   * prompt and the gesture expired).
   */
  async enter(): Promise<void> {
    const res = this.res;
    if (!res || this.st !== 'idle') return;
    const { xr, api } = this.deps;
    try {
      await xr.enter();
    } catch (err) {
      const e = new SessionError('xr_enter_failed', 'Could not enter the room', err);
      this.emitError(e);
      throw e;
    }
    this.setState('placing');
    try {
      await xr.place();
    } catch (err) {
      const e = new SessionError('placement_failed', 'Could not place the desk', err);
      this.emitError(e);
      throw e;
    }

    this.setState('greeting');
    this.panel = new PanelController(res, (p, o) => this.wire(this.deps.makeTransport(p, o, res)), { api });
    try {
      await this.panel.start();
    } catch (err) {
      const e = err instanceof VoiceError ? err : new VoiceError('connect_failed', String(err), err);
      this.emitError(e);
      this.setState('failed');
      throw e;
    }
    this.releaseMic(); // the voice service holds its own capture now
    const head = this.deps.head;
    if (head) {
      head.setFloor(this.panel.floor);
      head.start((samples) => this.socket?.send('head.samples', { samples }));
    }
    this.floorT()?.sendEvent(VOICE_MARKERS.start);
  }

  /** The user is working on the board: resets the silence timer. */
  noteUserActivity(): void {
    for (const t of this.panel?.all() ?? []) t.noteActivity?.();
    this.silenceFired = false;
    this.rearmSilence();
  }

  /** A typed user turn (dev console). */
  sendTypedTurn(text: string): void {
    this.floorT()?.sendText(text);
  }

  /** Asks the floor panelist for a time check (the server says a phase ran out). */
  timeCheck(): void {
    if (this.st === 'live') this.floorT()?.sendEvent(VOICE_MARKERS.timeCheck);
  }

  setMuted(muted: boolean): void {
    this.userMuted = muted;
    if (this.st !== 'paused') this.panel?.muteAll(muted);
  }

  pause(reason?: string): void {
    if (this.st !== 'live' && this.st !== 'greeting') return;
    this.setState('paused');
    this.panel?.muteAll(true);
    for (const t of this.panel?.all() ?? []) t.interrupt?.();
    this.socket?.send('ui.event', reason ? { kind: 'pause', reason } : { kind: 'pause' });
    this.clearTimers();
  }

  resume(): void {
    if (this.st !== 'paused') return;
    this.panel?.muteAll(this.userMuted);
    this.socket?.send('ui.event', { kind: 'resume' });
    this.floorT()?.sendEvent(VOICE_MARKERS.resume);
    this.greeted = true;
    this.setState('live');
  }

  /** Ends the round: the interviewer says goodbye, then the round is scored. */
  end(reason: EndReason = 'user_ended'): void {
    if (this.st !== 'live' && this.st !== 'paused' && this.st !== 'greeting') return;
    this.socket?.send('ui.event', { kind: 'end' });
    this.beginEnding(reason);
  }

  /** Tears everything down (leaving the page). */
  async dispose(): Promise<void> {
    this.clearTimers();
    if (this.endingTimer) clearTimeout(this.endingTimer);
    for (const u of this.unsubs.splice(0)) u();
    this.deps.head?.stop();
    this.releaseMic();
    const panel = this.panel;
    this.panel = null;
    await panel?.stopAll();
    this.socket?.close();
  }

  // ---------- wiring ----------

  private openSocket(res: CreateSessionRes): void {
    const s = this.deps.makeSocket(res.ws_url, res.client_token);
    this.socket = s;
    this.unsubs.push(
      s.on('round.state', (d) => this.onRoundState(d)),
      s.on('panel.hand_over', (d) => this.handOver(d.to, d.opening_line)),
      s.on('round.ending', () => this.beginEnding(null)),
      s.on('round.ended', () => this.onRoundEnded()),
      s.on('report.progress', (d) => {
        if (this.st === 'scoring') this.deps.xr.ui.setStatus('Writing your scorecard', d.pct);
      }),
      s.on('report.ready', () => void this.showReport()),
    );
    void s.connect().catch(() => undefined);
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
  }

  private onAction(a: UiAction): void {
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

  private handOver(to: string, openingLine: string): void {
    const panel = this.panel;
    if (!panel) return;
    panel
      .handOver(to, openingLine)
      .then(() => {
        const live = new Set(panel.all());
        for (const t of [...this.modes.keys()]) if (!live.has(t)) this.modes.delete(t);
        this.deps.head?.setFloor(panel.floor);
        this.rearmSilence();
      })
      .catch((err) => this.emitError(err instanceof VoiceError ? err : new VoiceError('connect_failed', String(err), err)));
  }

  // ---------- voice events ----------

  private onMode(t: VoiceTransport, m: VoiceMode): void {
    const now = Date.now();
    this.modes.set(t, m);
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
    if (m === 'speaking') {
      this.cand = null; // the agent answered: the candidate's turn is over
      this.silenceFired = false;
      this.greeted = true;
      if (this.st === 'ending') this.endingSawSpeech = true;
    }

    const msg: VoiceStateMsg = { panelist_id: t.panelistId, mode: m, at_ms: now };
    const split = this.latency.take();
    if (split) msg.latency = split;
    this.socket?.send('voice.state', msg);

    if (m === 'listening') {
      if (this.st === 'greeting' && this.greeted) this.setState('live');
      if (this.st === 'ending' && this.endingSawSpeech) void this.finishEnding();
    }
    this.rearmSilence();
  }

  private onUser(t: VoiceTransport, gen: number, e: UserTranscript): void {
    if (isMarker(e.text)) return;
    const key = `${t.panelistId}.${gen}.${e.segmentId}`;
    if (this.marked.has(key)) return;
    const now = Date.now();
    if (!this.segments.has(key)) this.segments.set(key, now);

    if (!this.userSpeaking) this.setUserSpeaking(true);
    this.trackTurn(now, e.final);
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
      this.latency.userFinal(now);
      if (this.st === 'greeting') this.setState('live');
    }
    this.events.emit('transcript', { panelistId: t.panelistId, role: 'user', text: e.text, final: e.final });
    this.rearmSilence();
  }

  private onAgentText(t: VoiceTransport, e: AgentText): void {
    const split = this.latency.agentText(Date.now());
    if (split) this.events.emit('latency', split);
    this.events.emit('transcript', { panelistId: t.panelistId, role: 'agent', text: e.text, final: false });
  }

  private onEnded(t: VoiceTransport, reason: string): void {
    this.modes.delete(t);
    // Transports we stop (hand-over, round end) are not the floor any more by then.
    if (this.floorT() !== t || this.finishing) return;
    if (this.st === 'live' || this.st === 'greeting' || this.st === 'paused') {
      this.emitError(new VoiceError('voice_lost', `The voice connection ended (${reason})`));
      this.deps.xr.ui.setStatus('We lost the connection to your interviewer');
    }
  }

  private setUserSpeaking(b: boolean): void {
    this.userSpeaking = b;
    this.deps.head?.setUserSpeaking(b);
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
    if (!c || c.sent || this.req?.mode !== 'interview' || this.st !== 'live') return;
    if (this.agentIs('speaking')) return;
    const now = Date.now();
    const ongoing = c.inSegment || now - c.lastFinal < TURN_GAP_MS;
    if (ongoing && now - c.start > this.timing.interruptAfterSeconds * 1000) {
      c.sent = true;
      this.floorT()?.sendEvent(LONG_ANSWER_MARKER);
    }
  }

  // ---------- silence ----------

  private agentIs(...ms: VoiceMode[]): boolean {
    for (const m of this.modes.values()) if (ms.includes(m)) return true;
    return false;
  }

  private rearmSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (!this.silenceCanRun()) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (!this.silenceCanRun()) return;
      this.silenceFired = true;
      this.floorT()?.sendEvent(VOICE_MARKERS.silenceCheck);
    }, this.timing.silenceWaitSeconds * 1000);
  }

  private silenceCanRun(): boolean {
    return this.st === 'live' && !this.silenceFired && !this.userSpeaking && !this.agentIs('thinking', 'speaking');
  }

  private clearTimers(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.candTimer) clearTimeout(this.candTimer);
    this.silenceTimer = null;
    this.candTimer = null;
    this.cand = null;
  }

  // ---------- server round state ----------

  private onRoundState(d: RoundStatePayload): void {
    const prev = this.lastRound;
    this.lastRound = d;
    this.deps.xr.ui.setRoundState({ ...d, controller: this.st });
    if (prev && d.phase_index > prev.phase_index && prev.phase_remaining_s <= PHASE_TIME_SLACK_S) {
      this.timeCheck();
    }
  }

  // ---------- ending and scoring ----------

  /** reason null: the server ends the round (time limit, end_round) and reports it itself. */
  private beginEnding(reason: EndReason | null): void {
    if (this.st !== 'live' && this.st !== 'paused' && this.st !== 'greeting') return;
    this.endReason = reason;
    this.endingSawSpeech = false;
    this.clearTimers();
    this.setState('ending');
    this.floorT()?.sendEvent(VOICE_MARKERS.ending);
    this.endingTimer = setTimeout(() => void this.finishEnding(), ENDING_GRACE_MS);
  }

  private onRoundEnded(): void {
    if (this.st === 'live' || this.st === 'paused' || this.st === 'greeting') {
      this.endReason = null;
      void this.finishEnding();
    }
  }

  private finishEnding(): Promise<void> {
    if (!this.finishing) this.finishing = this.doFinish();
    return this.finishing;
  }

  private async doFinish(): Promise<void> {
    if (this.endingTimer) clearTimeout(this.endingTimer);
    this.endingTimer = null;
    this.clearTimers();
    this.deps.head?.stop();
    await this.panel?.stopAll();
    this.setState('scoring');
    this.deps.xr.ui.setStatus('Writing your scorecard', 0);
    const res = this.res;
    if (res && this.endReason) {
      await this.deps.api.endSession(res.session_id, this.endReason).catch((e) => this.emitError(e as ApiError));
    }
  }

  private async showReport(): Promise<void> {
    const res = this.res;
    if (!res || this.st === 'summary') return;
    try {
      const report = await this.deps.api.report(res.session_id);
      this.deps.xr.ui.setStatus(null);
      this.deps.xr.ui.showSummary(report);
      this.setState('summary');
    } catch (err) {
      this.emitError(err as ApiError);
    }
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
  return new VoiceError('mic_denied', 'Microphone access was not allowed', err);
}
