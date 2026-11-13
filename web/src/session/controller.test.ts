import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMsgMap,
  ClientMsgType,
  CreateSessionReq,
  CreateSessionRes,
  HeadsetCard,
  Panelist,
  Report,
  ServerMsgMap,
  ServerMsgType,
} from '../shared/types';
import type { SocketStatus } from '../net/ws';
import { panelist, ScriptedTransport, sessionRes } from '../voice/testkit';
import { VoiceError, type TransportOptions } from '../voice/transport';
import { RoundController, SessionError, type RoundControllerDeps, type RoundError } from './controller';
import type { AvatarPort, HeadSamplerPort, SocketPort, UiAction, VisibilityPort, XRPort } from './ports';
import { StageTimings } from './timings';

class FakeSocket implements SocketPort {
  sent: { t: string; d: Record<string, unknown> }[] = [];
  private handlers = new Map<string, Set<(d: never) => void>>();
  terminalCbs = new Set<(i: { code: number; reason: string }) => void>();
  statusCbs = new Set<(s: SocketStatus) => void>();
  connectError: Error | null = null;
  constructor(private readonly log: string[]) {}
  connects = 0;
  async connect(): Promise<void> {
    this.connects++;
    this.log.push('socket.connect');
    if (this.connectError) throw this.connectError;
  }
  onTerminal(cb: (i: { code: number; reason: string }) => void): () => void {
    this.terminalCbs.add(cb);
    return () => this.terminalCbs.delete(cb);
  }
  onStatus(cb: (s: SocketStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }
  status(st: SocketStatus): void {
    for (const cb of [...this.statusCbs]) cb(st);
  }
  terminal(code: number): void {
    for (const cb of [...this.terminalCbs]) cb({ code, reason: '' });
  }
  send<T extends ClientMsgType>(t: T, d: ClientMsgMap[T]): void {
    this.sent.push({ t, d: d as Record<string, unknown> });
  }
  on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T]) => void): () => void {
    let set = this.handlers.get(t);
    if (!set) this.handlers.set(t, (set = new Set()));
    set.add(cb as (d: never) => void);
    return () => set.delete(cb as (d: never) => void);
  }
  close(): void {
    this.log.push('socket.close');
  }
  serverSend<T extends ServerMsgType>(t: T, d: ServerMsgMap[T]): void {
    for (const cb of this.handlers.get(t) ?? []) (cb as (d: ServerMsgMap[T]) => void)(d);
  }
  of<T extends ClientMsgType>(t: T): ClientMsgMap[T][] {
    return this.sent.filter((m) => m.t === t).map((m) => m.d as unknown as ClientMsgMap[T]);
  }
}

class FakeVisibility implements VisibilityPort {
  visibilityState: DocumentVisibilityState = 'visible';
  private cbs = new Set<() => void>();
  addEventListener(_t: 'visibilitychange', cb: () => void): void {
    this.cbs.add(cb);
  }
  removeEventListener(_t: 'visibilitychange', cb: () => void): void {
    this.cbs.delete(cb);
  }
  set(v: DocumentVisibilityState): void {
    this.visibilityState = v;
    for (const cb of [...this.cbs]) cb();
  }
}

const REPORT = { headline: { summary: 'ok' } } as unknown as Report;

/** A transport whose start() waits for release(), or rejects with fail(). */
class SlowTransport extends ScriptedTransport {
  release!: () => void;
  fail!: (e: Error) => void;
  override async start(): Promise<void> {
    this.started = true;
    await new Promise<void>((res, rej) => {
      this.release = res;
      this.fail = rej;
    });
  }
}

/** A transport whose mute takes effect only when the test releases it (like a real track mute). */
class SlowMuteTransport extends ScriptedTransport {
  pending: { muted: boolean; done: () => void; fail: (e: Error) => void }[] = [];
  hold = false;
  override setMicMuted(m: boolean): void | Promise<void> {
    super.setMicMuted(m);
    if (!this.hold) return;
    return new Promise<void>((done, fail) => this.pending.push({ muted: m, done, fail }));
  }
}

function harness(
  opts: {
    mode?: 'interview' | 'meeting';
    voice?: 'fish' | 'fake';
    panelMode?: 'swap' | 'joined';
    slow?: string[];
    /** Panelists whose mic mute resolves only when the test says so (or rejects). */
    slowMute?: string[];
    res?: Partial<CreateSessionRes>;
    noTiming?: boolean;
  } = {},
) {
  const log: string[] = [];
  const transports: ScriptedTransport[] = [];
  const socket = new FakeSocket(log);
  const visibility = new FakeVisibility();
  let uiAction: ((a: UiAction) => void) | null = null;
  let gesture: (() => void) | null = null;
  let inSession = true;
  const showCard = vi.fn();
  const timings = new StageTimings();
  const avatars = new Map<string, AvatarPort & { modes: string[] }>();
  const avatarFor = (pid: string) => {
    let a = avatars.get(pid);
    if (!a) {
      const modes: string[] = [];
      a = { modes, setMode: (m) => modes.push(m), attachVoice: vi.fn() };
      avatars.set(pid, a);
    }
    return a;
  };
  const xr: XRPort = {
    enter: vi.fn(async () => void log.push('xr.enter')),
    place: vi.fn(async () => void log.push('xr.place')),
    inSession: () => inSession,
    startCue: vi.fn(async () => void log.push('xr.startCue')),
    onGesture: (cb) => {
      gesture = cb;
      return () => (gesture = null);
    },
    ui: {
      setRoundState: vi.fn(),
      showSummary: vi.fn(),
      showCard,
      setStatus: vi.fn(),
      onAction: (cb) => {
        uiAction = cb;
        return () => (uiAction = null);
      },
    },
    room: { seatPoses: () => [] },
  };
  const head: HeadSamplerPort & { speaking: boolean[] } = {
    speaking: [],
    start: vi.fn(),
    stop: vi.fn(),
    setUserSpeaking(b) {
      this.speaking.push(b);
    },
    setFloor: vi.fn(),
  };
  const boardCbs = new Set<() => void>();
  const api = {
    createSession: vi.fn(async (_req: CreateSessionReq) => {
      log.push('api.createSession');
      return sessionRes({ panel_mode: opts.panelMode ?? 'swap', ...opts.res });
    }),
    retry: vi.fn(async (_id: string) => {
      log.push('api.retry');
      return sessionRes({ panel_mode: opts.panelMode ?? 'swap' });
    }),
    resumeSession: vi.fn(async (_id: string) => {
      log.push('api.resumeSession');
      return sessionRes({ panel_mode: opts.panelMode ?? 'swap' });
    }),
    joinPanelist: vi.fn(async () => ({ voice: { transport: 'fake' as const } })),
    endSession: vi.fn(async () => void log.push('api.endSession')),
    report: vi.fn(async () => REPORT),
  };
  const micTrack = { stop: vi.fn() };
  const media = {
    getMic: vi.fn(async () => {
      log.push('media.getMic');
      return { getTracks: () => [micTrack] } as unknown as MediaStream;
    }),
    resumeAudio: vi.fn(async () => void log.push('media.resumeAudio')),
  };
  const deps: RoundControllerDeps = {
    api,
    makeSocket: () => socket,
    makeTransport: (p: Panelist, o?: TransportOptions) => {
      const T = opts.slowMute?.includes(p.panelist_id) ? SlowMuteTransport : opts.slow?.includes(p.panelist_id) ? SlowTransport : ScriptedTransport;
      const t = new T(p.panelist_id, log, o, p);
      transports.push(t);
      return t;
    },
    xr,
    avatars: avatarFor,
    board: { onActivity: (cb) => (boardCbs.add(cb), () => boardCbs.delete(cb)) },
    head,
    media,
    visibility,
    timing: opts.noTiming ? undefined : { silenceWaitSeconds: 20, interruptAfterSeconds: 10 },
    timings,
  };
  const ctl = new RoundController(deps);
  const req: CreateSessionReq = {
    mode: opts.mode ?? 'interview',
    round_id: 'beh_short',
    length: 'short',
    level: 'mid',
    style: 'neutral',
    voice: opts.voice ?? 'fake',
  };
  const floor = () => transports.filter((t) => !t.stopped).at(-1)!;
  const markers = () => transports.flatMap((t) => t.sentEvents);
  return {
    ctl,
    req,
    log,
    socket,
    visibility,
    transports,
    floor,
    markers,
    api,
    media,
    xr,
    head,
    avatars,
    micTrack,
    deps,
    board: () => boardCbs.forEach((cb) => cb()),
    ui: (a: UiAction) => uiAction?.(a),
    gesture: () => gesture?.(),
    setInSession: (b: boolean) => (inSession = b),
    showCard,
    timings,
  };
}

/** Starts a round and plays the greeting, leaving the controller live. */
async function live(h: ReturnType<typeof harness>) {
  await h.ctl.start(h.req);
  const t = h.floor();
  t.mode('thinking');
  t.mode('speaking');
  t.agent('a0', 'Hi, thanks for coming in.');
  t.mode('listening');
  expect(h.ctl.state).toBe('live');
  h.socket.sent.length = 0;
  t.sentEvents.length = 0;
  return t;
}

const count = (xs: string[], x: string) => xs.filter((v) => v === x).length;

describe('RoundController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('start_sequence_runs_in_order', async () => {
    const h = harness();
    const states: string[] = [];
    h.ctl.on('state', (s) => states.push(s));
    await h.ctl.start(h.req);
    const order = [
      'media.getMic',
      'media.resumeAudio',
      'api.createSession',
      'xr.enter',
      'xr.place',
      'start:p1',
      'event:p1:[event: start]',
    ];
    const idx = order.map((x) => h.log.indexOf(x));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(states).toEqual(['placing', 'greeting']);
    expect(h.floor().muted).toBe(false);
    expect(h.head.start).toHaveBeenCalled();
  });

  it('mic_denied_emits_typed_error', async () => {
    const h = harness({ voice: 'fish' });
    h.media.getMic.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    const errors: VoiceError[] = [];
    h.ctl.on('error', (e) => errors.push(e as VoiceError));
    await expect(h.ctl.start(h.req)).rejects.toMatchObject({ code: 'mic_denied' });
    expect(errors[0]).toBeInstanceOf(VoiceError);
    expect(errors[0]?.code).toBe('mic_denied');
    expect(h.api.createSession).not.toHaveBeenCalled();
    expect(h.ctl.state).toBe('idle');
  });

  it('silence_check_fires_once_per_silence', async () => {
    const h = harness();
    const t = await live(h);
    const SC = '[event: silence_check]';

    vi.advanceTimersByTime(19_999);
    expect(count(t.sentEvents, SC)).toBe(0);
    vi.advanceTimersByTime(1);
    expect(count(t.sentEvents, SC)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(count(t.sentEvents, SC)).toBe(1);

    // The interviewer checks in; a new silence starts when it stops talking.
    t.mode('thinking');
    t.mode('speaking');
    t.agent('a1', 'Want to think out loud?');
    vi.advanceTimersByTime(30_000);
    expect(count(t.sentEvents, SC)).toBe(1);
    t.mode('listening');
    vi.advanceTimersByTime(20_000);
    expect(count(t.sentEvents, SC)).toBe(2);

    // Board activity resets the timer.
    t.mode('speaking');
    t.mode('listening');
    vi.advanceTimersByTime(15_000);
    h.board();
    vi.advanceTimersByTime(15_000);
    expect(count(t.sentEvents, SC)).toBe(2);
    expect(t.activity).toBeGreaterThan(0);
    vi.advanceTimersByTime(5_000);
    expect(count(t.sentEvents, SC)).toBe(3);

    // The user talking resets it too, and nothing fires mid-segment.
    t.mode('speaking');
    t.mode('listening');
    t.user('u1', 'So I', false);
    vi.advanceTimersByTime(25_000);
    expect(count(t.sentEvents, SC)).toBe(3);
    t.user('u1', 'So I think', true);
    vi.advanceTimersByTime(20_000);
    expect(count(t.sentEvents, SC)).toBe(4);
  });

  it('pause_on_hidden_mutes_and_sends_pause', async () => {
    const h = harness();
    const t = await live(h);
    t.mode('speaking');

    h.visibility.set('hidden');

    expect(h.ctl.state).toBe('paused');
    expect(t.muted).toBe(true);
    expect(t.interrupts).toBe(1);
    expect(h.socket.of('ui.event')).toEqual([{ kind: 'pause', reason: 'hidden' }]);

    // No silence check while paused.
    t.mode('listening');
    vi.advanceTimersByTime(120_000);
    expect(t.sentEvents).not.toContain('[event: silence_check]');

    h.visibility.set('visible');
    expect(h.ctl.state).toBe('paused'); // coming back needs a tap

    h.ui('resume');
    expect(h.ctl.state).toBe('live');
    expect(t.muted).toBe(false);
    expect(h.socket.of('ui.event').at(-1)).toEqual({ kind: 'resume' });
    expect(t.sentEvents).toContain('[event: resume]');
  });

  it('marks_sent_once_per_final_segment', async () => {
    const h = harness();
    const t = await live(h);
    const t0 = Date.now();

    t.user('s1', 'I', false);
    vi.advanceTimersByTime(500);
    t.user('s1', 'I would', false);
    vi.advanceTimersByTime(500);
    t.user('s1', 'I would use a cache', true);
    t.user('s1', 'I would use a cache', true);
    vi.advanceTimersByTime(200);
    t.user('s2', 'Yes', true);
    t.user('typed_9', '[event: start]', true);

    const marks = h.socket.of('transcript.mark');
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({
      panelist_id: 'p1',
      first_at_ms: t0,
      final_at_ms: t0 + 1000,
      text: 'I would use a cache',
    });
    expect(marks[0]!.segment_id).toContain('s1');
    expect(marks[1]).toMatchObject({ first_at_ms: t0 + 1200, final_at_ms: t0 + 1200, text: 'Yes' });
    expect(marks[0]!.segment_id).not.toEqual(marks[1]!.segment_id);
    expect(h.head.speaking).toEqual([true, false, true, false]);
  });

  it('long_answer_sent_once_per_candidate_turn', async () => {
    const h = harness();
    const t = await live(h);
    const LA = '[event: long_answer]';

    // Two segments with a 1 s gap form one turn.
    t.user('s1', 'Well', false);
    vi.advanceTimersByTime(4_000);
    t.user('s1', 'Well, first', true);
    vi.advanceTimersByTime(1_000);
    t.user('s2', 'and then', false);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1_000);
      t.user('s2', `and then ${i}`, false);
    }
    expect(count(t.sentEvents, LA)).toBe(0); // 9 s so far
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(700); // the mic closes first, then the marker
    expect(count(t.sentEvents, LA)).toBe(1);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(1_000);
      t.user('s2', `more ${i}`, false);
    }
    t.user('s2', 'done', true);
    expect(count(t.sentEvents, LA)).toBe(1);
  });

  it('long_answer_splits_turns_on_gaps_and_skips_meetings_and_agent_speech', async () => {
    // A 2 s gap starts a new turn: two 6 s turns never trigger.
    const h = harness();
    const t = await live(h);
    t.user('s1', 'a', false);
    vi.advanceTimersByTime(6_000);
    t.user('s1', 'a b', true);
    vi.advanceTimersByTime(2_000);
    t.user('s2', 'c', false);
    vi.advanceTimersByTime(6_000);
    t.user('s2', 'c d', true);
    vi.advanceTimersByTime(10_000);
    expect(t.sentEvents).not.toContain('[event: long_answer]');

    // Never while the agent is speaking.
    t.user('s3', 'x', false);
    vi.advanceTimersByTime(5_000);
    t.mode('speaking');
    vi.advanceTimersByTime(8_000);
    t.user('s3', 'x y', false);
    expect(t.sentEvents).not.toContain('[event: long_answer]');

    // Meetings never get it.
    const m = harness({ mode: 'meeting' });
    const mt = await live(m);
    mt.user('s1', 'a', false);
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(1_000);
      mt.user('s1', `a ${i}`, false);
    }
    expect(mt.sentEvents).not.toContain('[event: long_answer]');
  });

  it('latency_split_rides_on_voice_state', async () => {
    const h = harness();
    const t = await live(h);
    const splits: unknown[] = [];
    h.ctl.on('latency', (s) => splits.push(s));

    t.user('s1', 'I would shard by user', true);
    vi.advanceTimersByTime(300);
    t.mode('thinking');
    vi.advanceTimersByTime(900);
    t.mode('speaking');
    t.agent('a1', 'Why ');
    vi.advanceTimersByTime(2_000);
    t.mode('listening');

    const states = h.socket.of('voice.state') as (ClientMsgMap['voice.state'] & { latency?: unknown })[];
    expect(states.map((s) => s.mode)).toEqual(['thinking', 'speaking', 'listening']);
    expect(states[0]!.latency).toBeUndefined();
    expect(states[2]!.latency).toMatchObject({ to_thinking_ms: 300, to_first_text_ms: 1200 });
    expect(h.ctl.latencyHistory).toHaveLength(1);
    expect(splits).toHaveLength(1);
  });

  it('server_hand_over_swaps_the_floor', async () => {
    const h = harness();
    await live(h);
    h.socket.serverSend('panel.hand_over', { from: 'p1', to: 'p2', opening_line: 'Hi, I am Priya.' });
    await vi.waitFor(() => expect(h.transports[0]!.stopped).toBe(true));
    const p2 = h.transports[1]!;
    expect(p2.panelistId).toBe('p2');
    expect(p2.opts.openingLine).toBe('Hi, I am Priya.');
    expect(h.head.setFloor).toHaveBeenLastCalledWith('p2');
    // The new panelist's events now drive marks.
    p2.user('s1', 'Hello', true);
    expect(h.socket.of('transcript.mark')[0]).toMatchObject({ panelist_id: 'p2' });
  });

  it('phase_boundary_sends_time_check', async () => {
    const h = harness();
    const t = await live(h);
    const rs = (phase_index: number, phase_remaining_s: number) => ({
      status: 'live' as const,
      phase_id: `ph${phase_index}`,
      phase_index,
      phases: [],
      elapsed_s: 0,
      remaining_s: 600,
      phase_remaining_s,
      brief: { question: '', lines: [] },
      floor: 'p1',
    });
    h.socket.serverSend('round.state', rs(0, 2));
    h.socket.serverSend('round.state', rs(0, 1));
    h.socket.serverSend('round.state', rs(1, 300));
    h.socket.serverSend('round.state', rs(1, 299));
    expect(count(t.sentEvents, '[event: time_check]')).toBe(1);
    expect(h.xr.ui.setRoundState).toHaveBeenCalled();
  });

  it('end_says_goodbye_then_scores_and_shows_summary', async () => {
    const h = harness();
    const t = await live(h);
    const states: string[] = [];
    h.ctl.on('state', (s) => states.push(s));

    h.ui('end');
    expect(h.ctl.state).toBe('ending');
    expect(h.socket.of('ui.event')).toEqual([{ kind: 'end' }]);
    expect(t.sentEvents).toEqual(['[event: ending]']);

    t.mode('speaking');
    t.agent('a9', 'Thanks, that is all from me.');
    t.mode('listening');
    await vi.waitFor(() => expect(h.api.endSession).toHaveBeenCalledWith('sess1', 'user_ended'));
    expect(t.stopped).toBe(true);
    expect(h.ctl.state).toBe('scoring');

    h.socket.serverSend('report.progress', { stage: 'scoring', pct: 40 });
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(expect.any(String), 0.4); // the bar wants 0 to 1
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    await vi.waitFor(() => expect(h.xr.ui.showSummary).toHaveBeenCalledWith(REPORT));
    expect(states).toEqual(['ending', 'scoring', 'summary']);
  });
});

const rs = (phase_index: number, phase_remaining_s: number, time_check_due?: boolean) => ({
  status: 'live' as const,
  phase_id: `ph${phase_index}`,
  phase_index,
  phases: [],
  elapsed_s: 0,
  remaining_s: 600,
  phase_remaining_s,
  brief: { question: '', lines: [] },
  floor: 'p1',
  ...(time_check_due === undefined ? {} : { time_check_due }),
});

function errorsOf(h: ReturnType<typeof harness>): RoundError[] {
  const errors: RoundError[] = [];
  h.ctl.on('error', (e) => errors.push(e));
  return errors;
}

describe('RoundController two phase start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prepare_does_mic_session_and_room_but_not_xr', async () => {
    const h = harness();
    const preload = vi.fn(async () => void h.log.push('xr.preload'));
    h.xr.preload = preload;
    await h.ctl.prepare({ kind: 'new', req: h.req });
    // No hello yet: the round starts on the server only once the desk is placed.
    expect(h.log).toEqual(['media.getMic', 'media.resumeAudio', 'api.createSession', 'xr.preload']);
    expect(h.xr.enter).not.toHaveBeenCalled();
    expect(h.ctl.state).toBe('idle');
    expect(h.ctl.prepared).toBe(true);
  });

  it('enter_awaits_nothing_before_request_session', async () => {
    const h = harness();
    await h.ctl.prepare({ kind: 'new', req: h.req });
    h.log.length = 0;
    const p = h.ctl.enter();
    // Synchronously, before any microtask: the XR request is already made.
    expect(h.xr.enter).toHaveBeenCalledTimes(1);
    expect(h.log).toEqual(['xr.enter']);
    await p;
    expect(h.log.slice(0, 2)).toEqual(['xr.enter', 'xr.place']);
  });

  it('prepare_failure_leaves_a_retryable_state', async () => {
    const h = harness();
    h.api.createSession.mockRejectedValueOnce(new Error('offline'));
    await expect(h.ctl.prepare({ kind: 'new', req: h.req })).rejects.toThrow('offline');
    expect(h.micTrack.stop).toHaveBeenCalled();
    expect(h.ctl.prepared).toBe(false);
    await expect(h.ctl.enter()).rejects.toMatchObject({ code: 'not_prepared' });

    await h.ctl.prepare({ kind: 'new', req: h.req });
    expect(h.ctl.prepared).toBe(true);
    await h.ctl.enter();
    expect(h.ctl.state).toBe('greeting');
  });

  it('a_failed_room_load_reuses_the_session_on_retry', async () => {
    const h = harness();
    h.xr.preload = vi.fn().mockRejectedValueOnce(new Error('gl')).mockResolvedValue(undefined);
    const errors: RoundError[] = [];
    h.ctl.on('error', (e) => errors.push(e));
    await expect(h.ctl.prepare({ kind: 'new', req: h.req })).rejects.toMatchObject({ code: 'room_load_failed' });
    expect(errors.map((e) => e.code)).toEqual(['room_load_failed']);
    await h.ctl.prepare({ kind: 'new', req: h.req });
    expect(h.api.createSession).toHaveBeenCalledTimes(1);
    expect(h.ctl.prepared).toBe(true);
  });

  it('retry_and_resume_post_in_phase_a', async () => {
    const r = harness();
    await r.ctl.prepare({ kind: 'retry', parentSessionId: 's_parent', voice: 'fake' });
    expect(r.api.retry).toHaveBeenCalledWith('s_parent');
    expect(r.api.createSession).not.toHaveBeenCalled();
    expect(r.xr.enter).not.toHaveBeenCalled();

    const m = harness();
    await m.ctl.prepare({ kind: 'resume', sessionId: 's_drop', voice: 'fake' });
    expect(m.api.resumeSession).toHaveBeenCalledWith('s_drop');
    expect(m.xr.enter).not.toHaveBeenCalled();
  });

  it('prepare_uses_the_stream_the_page_holds', async () => {
    const h = harness();
    const track = { stop: vi.fn() };
    await h.ctl.prepare({ kind: 'new', req: h.req }, { mic: { getTracks: () => [track] } as unknown as MediaStream });
    expect(h.media.getMic).not.toHaveBeenCalled();
    await h.ctl.dispose();
    expect(track.stop).toHaveBeenCalled();
  });

  it('dispose_frees_the_preloaded_room', async () => {
    const h = harness();
    h.xr.preload = vi.fn(async () => {});
    h.xr.dispose = vi.fn();
    await h.ctl.prepare({ kind: 'new', req: h.req });
    await h.ctl.dispose();
    expect(h.xr.dispose).toHaveBeenCalledTimes(1);
  });

  it('prepare_twice_is_refused', async () => {
    const h = harness();
    await h.ctl.prepare({ kind: 'new', req: h.req });
    await expect(h.ctl.prepare({ kind: 'new', req: h.req })).rejects.toMatchObject({ code: 'already_started' });
  });
});

describe('RoundController lifecycle races', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('end_while_voices_connect_stops_them_and_never_greets', async () => {
    const h = harness({ slow: ['p1'] });
    const starting = h.ctl.start(h.req);
    await vi.waitFor(() => expect(h.transports).toHaveLength(1));
    expect(h.ctl.state).toBe('greeting');
    h.ui('end');
    await vi.waitFor(() => expect(h.ctl.state).toBe('scoring'));
    (h.transports[0] as SlowTransport).release();
    await starting;
    expect(h.transports[0]!.stopped).toBe(true);
    expect(h.markers()).not.toContain('[event: start]');
    expect(h.head.start).not.toHaveBeenCalled();
    expect(h.api.endSession).toHaveBeenCalledWith('sess1', 'user_ended');
  });

  it('pause_while_voices_connect_greets_after_resume', async () => {
    const h = harness({ slow: ['p1'] });
    const starting = h.ctl.start(h.req);
    await vi.waitFor(() => expect(h.transports).toHaveLength(1));
    h.visibility.set('hidden');
    (h.transports[0] as SlowTransport).release();
    await starting;
    const t = h.transports[0]!;
    expect(h.ctl.state).toBe('paused');
    expect(t.muted).toBe(true);
    expect(t.sentEvents).toEqual([]);
    h.ui('resume');
    expect(t.sentEvents).toEqual(['[event: start]']);
    expect(h.ctl.state).toBe('greeting');
    expect(t.muted).toBe(false);
  });

  it('voice_start_failure_stops_started_voices_and_releases_mic', async () => {
    const h = harness({ panelMode: 'joined', slow: ['p2'] });
    const starting = h.ctl.start(h.req);
    await vi.waitFor(() => expect(h.transports).toHaveLength(2));
    (h.transports[1] as SlowTransport).fail(new Error('livekit down'));
    await expect(starting).rejects.toMatchObject({ code: 'connect_failed' });
    expect(h.transports[0]!.stopped).toBe(true);
    expect(h.transports[1]!.stopped).toBe(true);
    expect(h.micTrack.stop).toHaveBeenCalled();
    expect(h.ctl.state).toBe('failed');
  });

  it('placement_failure_can_be_retried', async () => {
    const h = harness();
    vi.mocked(h.xr.place).mockRejectedValueOnce(new Error('no desk'));
    await expect(h.ctl.start(h.req)).rejects.toMatchObject({ code: 'placement_failed' });
    expect(h.ctl.state).toBe('placing');
    await h.ctl.enter();
    expect(h.xr.enter).toHaveBeenCalledTimes(1);
    expect(h.ctl.state).toBe('greeting');
    expect(h.markers()).toEqual(['[event: start]']);
  });

  it('dispose_during_placement_starts_no_voice', async () => {
    const h = harness();
    let placed!: () => void;
    vi.mocked(h.xr.place).mockImplementationOnce(() => new Promise<void>((r) => (placed = r)));
    const starting = h.ctl.start(h.req);
    await vi.waitFor(() => expect(h.ctl.state).toBe('placing'));
    await h.ctl.dispose();
    placed();
    await starting;
    // The voice was connecting during placement: it is stopped and never greets.
    expect(h.transports.every((t) => t.stopped)).toBe(true);
    expect(h.markers()).toEqual([]);
  });

  it('mic_busy_is_not_reported_as_denied', async () => {
    const h = harness({ voice: 'fish' });
    h.media.getMic.mockRejectedValueOnce(Object.assign(new Error('busy'), { name: 'NotReadableError' }));
    await expect(h.ctl.start(h.req)).rejects.toMatchObject({ code: 'mic_busy' });
  });

  it('start_does_not_wait_for_audio_resume', async () => {
    const h = harness();
    h.media.resumeAudio.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    await h.ctl.start(h.req);
    expect(h.ctl.state).toBe('greeting');
  });
});

describe('RoundController hand-overs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hand_over_waits_while_paused_and_is_ignored_after_the_round', async () => {
    const h = harness();
    const t = await live(h);
    h.visibility.set('hidden');
    h.socket.serverSend('panel.hand_over', { from: 'p1', to: 'p2', opening_line: 'Hi' });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.api.joinPanelist).not.toHaveBeenCalled();

    h.ui('resume');
    await vi.waitFor(() => expect(t.stopped).toBe(true));
    expect(h.transports[1]!.panelistId).toBe('p2');
    expect(t.sentEvents).not.toContain('[event: resume]');

    const p2 = h.transports[1]!;
    h.ui('end');
    p2.mode('speaking');
    p2.mode('listening');
    await vi.waitFor(() => expect(h.ctl.state).toBe('scoring'));
    h.socket.serverSend('panel.hand_over', { from: 'p2', to: 'p1', opening_line: 'Me again' });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.transports).toHaveLength(2);
    expect(h.api.joinPanelist).toHaveBeenCalledTimes(1);
  });

  it('hand_over_lets_the_outgoing_panelist_finish', async () => {
    const h = harness();
    const t = await live(h);
    t.mode('speaking');
    h.socket.serverSend('panel.hand_over', { from: 'p1', to: 'p2', opening_line: 'Hi' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.api.joinPanelist).not.toHaveBeenCalled();
    t.mode('listening');
    await vi.waitFor(() => expect(h.api.joinPanelist).toHaveBeenCalled());

    // The wait is capped.
    const h2 = harness();
    const t2 = await live(h2);
    t2.mode('speaking');
    h2.socket.serverSend('panel.hand_over', { from: 'p1', to: 'p2', opening_line: 'Hi' });
    await vi.advanceTimersByTimeAsync(4900);
    expect(h2.api.joinPanelist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(h2.api.joinPanelist).toHaveBeenCalled();
  });

  it('no_markers_or_voice_lost_during_a_hand_over', async () => {
    const h = harness({ slow: ['p2'] });
    const t = await live(h);
    const errors = errorsOf(h);
    h.socket.serverSend('panel.hand_over', { from: 'p1', to: 'p2', opening_line: 'Hi' });
    await vi.waitFor(() => expect(h.transports).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.sentEvents).toEqual([]);
    t.events.emit('ended', { reason: 'agent_hangup' });
    expect(errors).toEqual([]);
    (h.transports[1] as SlowTransport).release();
    await vi.waitFor(() => expect(t.stopped).toBe(true));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.transports[1]!.sentEvents).toEqual(['[event: silence_check]']);
  });

  it('transcripts_from_a_non_floor_session_are_ignored', async () => {
    const h = harness({ panelMode: 'joined' });
    await live(h);
    const p2 = h.transports.find((t) => t.panelistId === 'p2')!;
    p2.user('x1', 'I would use a queue', true);
    expect(h.socket.of('transcript.mark')).toEqual([]);
    h.transports[0]!.user('x1', 'I would use a queue', true);
    expect(h.socket.of('transcript.mark')).toHaveLength(1);
  });
});

describe('RoundController socket, audio and server signals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('socket_failures_surface_as_typed_errors', async () => {
    const h = harness();
    const errors = errorsOf(h);
    await live(h);

    h.socket.serverSend('error', { code: 'op_rejected', message: 'bad op', op_id: 'o1' });
    h.socket.serverSend('error', { code: 'session_gone', message: 'Session is gone' });
    expect(errors.map((e) => (e as SessionError).code)).toEqual(['server_error']);

    h.socket.status('reconnecting');
    await vi.advanceTimersByTimeAsync(7_999);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((errors[1] as SessionError).code).toBe('socket_failed');
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith('Reconnecting to the room');
    h.socket.status('open');
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(null);

    h.socket.terminal(4409);
    expect(errors[2]).toBeInstanceOf(SessionError);
    expect((errors[2] as SessionError).code).toBe('socket_terminal');
  });

  it('a_failed_first_connect_is_reported', async () => {
    const h = harness();
    h.socket.connectError = new Error('refused');
    const errors = errorsOf(h);
    await h.ctl.start(h.req);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.map((e) => (e as SessionError).code)).toContain('socket_failed');
  });

  it('greeting_watchdog_offers_tap_to_hear', async () => {
    const h = harness();
    const errors = errorsOf(h);
    await h.ctl.start(h.req);
    const t = h.floor();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(errors.map((e) => (e as VoiceError).code)).toEqual(['audio_blocked']);
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith('Tap to hear your interviewer');

    h.ui('hear');
    expect(t.audioStarts).toBe(2); // once with the placement touch, once with this tap
    expect(t.sentEvents).toEqual(['[event: start]', '[event: start]']); // fake voice, nothing came back: resend
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(null);

    t.mode('thinking');
    await vi.advanceTimersByTimeAsync(8_000);
    h.ui('hear');
    expect(t.sentEvents).toHaveLength(2); // the agent reacted: only retry playback
    t.mode('speaking');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(errors).toHaveLength(2);
  });

  it('every_ui_action_retries_blocked_audio', async () => {
    const h = harness();
    const t = await live(h);
    h.ui('mute');
    h.ui('unmute');
    expect(t.audioStarts).toBe(3); // the placement touch and both taps
    expect(h.media.resumeAudio).toHaveBeenCalledTimes(4);
  });

  it('time_check_follows_time_check_due', async () => {
    const h = harness();
    const t = await live(h);
    const TC = '[event: time_check]';
    h.socket.serverSend('round.state', rs(0, 30, false));
    h.socket.serverSend('round.state', rs(0, 0, true));
    h.socket.serverSend('round.state', rs(0, 0, true));
    expect(count(t.sentEvents, TC)).toBe(1);
    h.socket.serverSend('round.state', rs(1, 300, false));
    expect(count(t.sentEvents, TC)).toBe(1);
    // Once the server says when, a quick phase change alone does not trigger one.
    h.socket.serverSend('round.state', rs(1, 1));
    h.socket.serverSend('round.state', rs(2, 300));
    expect(count(t.sentEvents, TC)).toBe(1);
    h.socket.serverSend('round.state', rs(2, 0, true));
    expect(count(t.sentEvents, TC)).toBe(2);
  });

  it('a_segment_that_never_finalizes_stops_blocking_silence_checks', async () => {
    const h = harness();
    const t = await live(h);
    t.user('u1', 'So', false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.head.speaking.at(-1)).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.sentEvents).toEqual(['[event: silence_check]']);
  });

  it('board_activity_reaches_the_voice_at_most_once_a_second', async () => {
    const h = harness();
    const t = await live(h);
    for (let i = 0; i < 5; i++) h.board();
    expect(t.activity).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    h.board();
    expect(t.activity).toBe(2);
  });

  it('long_answer_timer_only_runs_while_live', async () => {
    const h = harness();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const turnTimers = () => spy.mock.calls.filter((c) => c[1] === 10_001).length;
    await h.ctl.start(h.req);
    const t = h.floor();
    t.user('u1', 'hello', false); // during the greeting
    expect(turnTimers()).toBe(0);
    t.mode('speaking');
    t.mode('listening');
    h.ui('end'); // and during the goodbye
    t.user('u2', 'thanks', false);
    expect(turnTimers()).toBe(0);
  });
});

const CARD: HeadsetCard = {
  one_line: 'Clear on scale, thin on failure cases.',
  top_strength: { title: 'Sized the system first', evidence_id: 'c1', quote: 'about a hundred million a day', t_start_sec: 41 },
  top_fix: { title: 'Say what happens when the cache is cold', evidence_id: 'c2', quote: 'it just reads through', t_start_sec: 188 },
};

/** Ends a live round and leaves the controller in `scoring`. */
async function scoring(h: ReturnType<typeof harness>, t: ScriptedTransport) {
  h.ui('end');
  t.mode('speaking');
  t.mode('listening');
  await vi.waitFor(() => expect(h.ctl.state).toBe('scoring'));
}

describe('RoundController in the room', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('voices_connect_while_the_desk_is_placed_and_stay_muted_until_it_is_down', async () => {
    const h = harness();
    let placed!: () => void;
    vi.mocked(h.xr.place).mockImplementationOnce(() => new Promise<void>((r) => (placed = r)));
    const starting = h.ctl.start(h.req);
    await vi.waitFor(() => expect(h.transports[0]?.started).toBe(true));
    const t = h.transports[0]!;
    expect(h.ctl.state).toBe('placing');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.muted).toBe(true); // nobody hears the user before the greeting
    expect(t.sentEvents).toEqual([]);

    placed();
    await starting;
    expect(t.muted).toBe(false);
    expect(t.sentEvents).toEqual(['[event: start]']);
    expect(t.audioStarts).toBe(1); // the placement touch retried playback
    expect(h.transports).toHaveLength(1);
  });

  it('leaving_the_headset_during_placement_comes_back_through_the_controller', async () => {
    const h = harness();
    // The user leaves the headset view while the prompt shows: the session ends, placement is cancelled.
    vi.mocked(h.xr.place).mockImplementationOnce(async () => {
      h.setInSession(false);
      throw new Error('session ended');
    });
    await expect(h.ctl.start(h.req)).rejects.toMatchObject({ code: 'placement_failed' });
    expect(h.ctl.state).toBe('placing');
    expect(h.xr.enter).toHaveBeenCalledTimes(1);
    expect(h.socket.connects).toBe(0);

    // "Return to the room": the XR session is requested again (first, inside the tap), then the desk, then the greeting.
    vi.mocked(h.xr.enter).mockImplementationOnce(async () => {
      h.log.push('xr.enter');
      h.setInSession(true);
    });
    const back = h.ctl.returnToRoom();
    expect(h.xr.enter).toHaveBeenCalledTimes(2);
    await back;
    expect(h.ctl.state).toBe('greeting');
    expect(h.transports).toHaveLength(1); // the voice that connected the first time is kept
    expect(h.transports[0]!.sentEvents).toEqual(['[event: start]']);
    expect(h.transports[0]!.muted).toBe(false);
  });

  it('a_failed_placement_with_the_session_still_running_only_places_again', async () => {
    const h = harness();
    vi.mocked(h.xr.place).mockRejectedValueOnce(new Error('tracking lost'));
    await expect(h.ctl.start(h.req)).rejects.toMatchObject({ code: 'placement_failed' });
    await h.ctl.enter();
    expect(h.xr.enter).toHaveBeenCalledTimes(1);
    expect(h.transports).toHaveLength(1);
    expect(h.transports[0]!.sentEvents).toEqual(['[event: start]']);
  });

  it('end_works_while_the_desk_is_being_placed', async () => {
    const h = harness();
    const errors = errorsOf(h);
    vi.mocked(h.xr.place).mockImplementationOnce(() => new Promise<void>(() => undefined));
    void h.ctl.start(h.req).catch(() => undefined);
    await vi.waitFor(() => expect(h.transports[0]?.started).toBe(true));
    expect(h.ctl.state).toBe('placing');
    h.ctl.end();
    await vi.waitFor(() => expect(h.transports[0]!.stopped).toBe(true));
    expect(h.ctl.state).toBe('failed');
    await vi.waitFor(() => expect(errors.map((e) => (e as SessionError).code)).toEqual(['cancelled']));
    expect(h.markers()).toEqual([]);
    expect(h.socket.connects).toBe(0); // the server never saw this round start
    expect(h.api.endSession).not.toHaveBeenCalled();
  });

  it('hello_goes_out_only_once_the_desk_is_placed_and_the_chime_ends_before_the_start', async () => {
    const h = harness();
    let placed!: () => void;
    vi.mocked(h.xr.place).mockImplementationOnce(() => new Promise<void>((r) => (placed = r)));
    let chimeOver!: () => void;
    vi.mocked(h.xr.startCue!).mockImplementationOnce(() => new Promise<void>((r) => (chimeOver = r)));
    const starting = h.ctl.start(h.req);
    await vi.waitFor(() => expect(h.transports[0]?.started).toBe(true));
    expect(h.socket.connects).toBe(0);
    placed();
    await vi.waitFor(() => expect(h.socket.connects).toBe(1));
    const t = h.transports[0]!;
    await vi.advanceTimersByTimeAsync(0);
    // The chime is still playing: every mic is closed and nobody has been asked to speak.
    expect(t.muted).toBe(true);
    expect(t.sentEvents).toEqual([]);
    chimeOver();
    await starting;
    expect(t.muted).toBe(false);
    expect(t.sentEvents).toEqual(['[event: start]']);
  });

  it('a_resumed_round_asks_for_a_welcome_back_not_a_new_opening', async () => {
    const h = harness();
    await h.ctl.prepare({ kind: 'resume', sessionId: 'sess1', voice: 'fake' });
    await h.ctl.enter();
    expect(h.markers()).toEqual(['[event: resume]']);
    // Tap to hear never falls back to the opening either.
    await vi.advanceTimersByTimeAsync(8_000);
    h.ui('hear');
    expect(h.markers().every((m) => m === '[event: resume]')).toBe(true);
  });

  it('a_voice_token_past_its_deadline_makes_the_session_again_instead_of_failing', async () => {
    const fish = (expires_at: string) => ({ transport: 'fish' as const, fish: { session_id: 'f', token: 't', livekit_url: 'wss://x', expires_at } });
    const h = harness({ voice: 'fish', res: { panel: [panelist('p1', 0, fish('2026-11-13T10:00:30Z'))] } });
    const errors = errorsOf(h);
    const sessions: string[] = [];
    h.ctl.on('session', (r) => sessions.push(r.session_id));
    await h.ctl.prepare({ kind: 'new', req: h.req });
    // A long wait on the start page: the token minted at the mic tap has run out.
    vi.setSystemTime(new Date('2026-11-13T10:05:00Z'));
    h.api.createSession.mockImplementationOnce(async () => sessionRes({ session_id: 'sess2', panel: [panelist('p1', 0, fish('2026-11-13T10:10:00Z'))] }));
    await h.ctl.enter();
    expect(h.api.createSession).toHaveBeenCalledTimes(2);
    expect(sessions).toEqual(['sess2']);
    expect(h.ctl.session!.session_id).toBe('sess2');
    expect(h.transports).toHaveLength(1);
    expect((h.transports[0]!.panelist!.voice as ReturnType<typeof fish>).fish.expires_at).toBe('2026-11-13T10:10:00Z');
    expect(h.ctl.state).toBe('greeting');
    expect(errors).toEqual([]);
  });

  it('a_voice_that_reports_an_expired_session_on_join_is_retried_once_with_a_new_session', async () => {
    const h = harness({ voice: 'fish' });
    const errors = errorsOf(h);
    await h.ctl.prepare({ kind: 'new', req: h.req });
    const make = h.deps.makeTransport;
    let n = 0;
    h.deps.makeTransport = (p, o, r) => {
      const t = make(p, o, r);
      if (n++ === 0) t.start = async () => Promise.reject(new VoiceError('session_expired', 'expired'));
      return t;
    };
    await h.ctl.enter();
    expect(h.api.createSession).toHaveBeenCalledTimes(2);
    expect(h.ctl.state).toBe('greeting');
    expect(errors).toEqual([]);
    expect(h.floor().sentEvents).toEqual(['[event: start]']);
  });

  it('stage_timings_cover_the_start', async () => {
    const h = harness();
    await h.ctl.start(h.req);
    const t = h.floor();
    await vi.advanceTimersByTimeAsync(900);
    t.mode('speaking');
    const s = h.timings.spans();
    for (const k of ['session_ms', 'prepare_ms', 'xr_start_ms', 'placement_ms', 'voice_connect_ms', 'first_audio_ms', 'enter_to_first_word_ms'] as const) {
      expect(s[k], k).not.toBeNull();
    }
    expect(s.first_audio_ms).toBeGreaterThanOrEqual(900);
  });

  it('the_session_timing_sets_the_long_answer_and_silence_waits', async () => {
    const timing = { silence_wait_seconds: 7, interrupt_after_seconds: 5, target_minutes: 15, hard_stop_minutes: 20 };
    const h = harness({ noTiming: true, res: { timing } });
    const t = await live(h);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(t.sentEvents).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sentEvents).toEqual(['[event: silence_check]']);
  });

  it('a_hand_over_during_the_greeting_waits_until_the_round_is_live', async () => {
    const h = harness();
    await h.ctl.start(h.req);
    const t = h.floor();
    h.socket.serverSend('panel.hand_over', { from: 'p1', to: 'p2', opening_line: 'Hi' });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.api.joinPanelist).not.toHaveBeenCalled();
    t.mode('speaking');
    t.mode('listening'); // greeting done
    await vi.waitFor(() => expect(h.api.joinPanelist).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(t.stopped).toBe(true));
    expect(h.markers()).toEqual(['[event: start]']); // one greeting only
  });

  it('tap_to_hear_resends_the_start_to_a_real_voice_only_on_the_second_tap', async () => {
    const h = harness({ voice: 'fish' });
    await h.ctl.start(h.req);
    const t = h.floor();
    await vi.advanceTimersByTimeAsync(8_000);
    h.ui('hear');
    expect(t.sentEvents).toEqual(['[event: start]']); // the held greeting may still play
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith('Tap to hear your interviewer');
    h.ui('hear');
    expect(t.sentEvents).toEqual(['[event: start]', '[event: start]']);
  });

  it('resume_before_the_greeting_played_offers_tap_to_hear_again', async () => {
    const h = harness();
    const errors = errorsOf(h);
    await h.ctl.start(h.req);
    h.ui('pause');
    h.ui('resume');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(errors.map((e) => (e as VoiceError).code)).toEqual(['audio_blocked']);
  });

  it('a_time_check_that_falls_due_while_paused_is_sent_on_resume', async () => {
    const h = harness();
    const t = await live(h);
    h.ui('pause');
    h.socket.serverSend('round.state', rs(0, 0, true));
    expect(t.sentEvents).toEqual([]);
    h.ui('resume');
    expect(t.sentEvents).toEqual(['[event: resume]', '[event: time_check]']);
  });

  it('voice_spoken_goes_out_once_per_reply_with_the_first_words', async () => {
    const h = harness();
    const t = await live(h);
    t.mode('speaking');
    t.agent('a1', 'Good.', 'Good.');
    expect(h.socket.of('voice.spoken')).toEqual([]); // too short to tell yet
    t.agent('a1', ' Tell me how you would size the cache for this system and why.', 'Good. Tell me how you would size the cache for this system and why.');
    t.agent('a1', ' Take your time.', 'Good. Tell me how you would size the cache for this system and why. Take your time.');
    const sent = h.socket.of('voice.spoken');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.panelist_id).toBe('p1');
    expect(sent[0]!.text_prefix).toBe('Good. Tell me how you would size the cache for this system a');
    expect(sent[0]!.text_prefix).toHaveLength(60);

    // A short reply is reported when it ends.
    t.mode('listening');
    t.mode('speaking');
    t.agent('a2', 'Go on.');
    expect(h.socket.of('voice.spoken')).toHaveLength(1);
    t.mode('listening');
    expect(h.socket.of('voice.spoken').at(-1)).toEqual({ panelist_id: 'p1', text_prefix: 'Go on.' });
    expect(h.socket.of('voice.spoken')).toHaveLength(2);
  });

  /** Talks for 10 s without a break (the harness interrupts after 10 s). */
  async function talkTooLong(t: ScriptedTransport) {
    t.user('s1', 'So', false);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      t.user('s1', `So ${i}`, false);
    }
    await vi.advanceTimersByTimeAsync(100);
  }

  it('long_answer_marker_goes_out_only_after_the_mute_took_effect', async () => {
    const h = harness({ slowMute: ['p1'] });
    const t = (await live(h)) as SlowMuteTransport;
    const LA = '[event: long_answer]';
    t.hold = true;
    await talkTooLong(t);
    // The mute was asked for, but the track is not muted yet: no marker.
    expect(t.muted).toBe(true);
    expect(t.pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count(t.sentEvents, LA)).toBe(0);
    t.pending.shift()!.done();
    await vi.advanceTimersByTimeAsync(599);
    expect(count(t.sentEvents, LA)).toBe(0); // the service needs a moment to see the turn end
    await vi.advanceTimersByTimeAsync(1);
    expect(count(t.sentEvents, LA)).toBe(1);
    expect(t.muted).toBe(true);
    t.hold = false;
    t.mode('thinking'); // the interviewer takes the turn
    expect(t.muted).toBe(false);
  });

  it('the_mic_opens_again_after_a_long_answer_marker_with_no_reaction', async () => {
    const h = harness();
    const t = await live(h);
    await talkTooLong(t);
    await vi.advanceTimersByTimeAsync(700);
    expect(count(t.sentEvents, '[event: long_answer]')).toBe(1);
    expect(t.muted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(t.muted).toBe(false);
  });

  it('the_mic_never_stays_muted_when_the_long_answer_mute_fails_or_hangs', async () => {
    // The mute rejects: no marker, and the mic is opened again at once.
    const h = harness({ slowMute: ['p1'] });
    const t = (await live(h)) as SlowMuteTransport;
    t.hold = true;
    await talkTooLong(t);
    t.hold = false;
    t.pending.shift()!.fail(new Error('track gone'));
    await vi.advanceTimersByTimeAsync(0);
    expect(count(t.sentEvents, '[event: long_answer]')).toBe(0);
    expect(t.muted).toBe(false);

    // The mute never resolves: the marker goes out after a bounded wait and the mic still reopens.
    const h2 = harness({ slowMute: ['p1'] });
    const t2 = (await live(h2)) as SlowMuteTransport;
    t2.hold = true;
    await talkTooLong(t2);
    t2.hold = false;
    await vi.advanceTimersByTimeAsync(1_500 + 600);
    expect(count(t2.sentEvents, '[event: long_answer]')).toBe(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(t2.muted).toBe(false);

    // The round is paused while the mute is in flight: no marker; Resume opens the mic.
    const h3 = harness({ slowMute: ['p1'] });
    const t3 = (await live(h3)) as SlowMuteTransport;
    t3.hold = true;
    await talkTooLong(t3);
    t3.hold = false;
    h3.ui('pause');
    t3.pending.shift()!.done();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(count(t3.sentEvents, '[event: long_answer]')).toBe(0);
    expect(t3.muted).toBe(true); // paused
    h3.ui('resume');
    expect(t3.muted).toBe(false);
  });

  it('a_pinch_retries_blocked_audio_at_most_once_a_second', async () => {
    const h = harness();
    const t = await live(h);
    const before = t.audioStarts;
    h.gesture();
    h.gesture();
    expect(t.audioStarts).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    h.gesture();
    expect(t.audioStarts).toBe(before + 2);
  });

  it('the_quick_card_shows_first_and_the_summary_replaces_it', async () => {
    const h = harness();
    const t = await live(h);
    await scoring(h, t);
    h.socket.serverSend('report.progress', { stage: 'metrics', pct: 10 });
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith('Writing your scorecard', 0.1);
    h.socket.serverSend('report.progress', { stage: 'card', pct: 50, card: CARD });
    expect(h.showCard).toHaveBeenCalledWith(CARD);
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(null);
    // Later progress never covers the card.
    h.socket.serverSend('report.progress', { stage: 'scoring', pct: 80 });
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(null);
    expect(h.ctl.state).toBe('scoring');
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    await vi.waitFor(() => expect(h.xr.ui.showSummary).toHaveBeenCalledWith(REPORT));
    expect(h.ctl.state).toBe('summary');
  });

  it('a_failed_report_still_leaves_a_card_with_a_way_on', async () => {
    const h = harness();
    const t = await live(h);
    await scoring(h, t);
    h.socket.serverSend('error', { code: 'report_failed', message: 'scoring gave up' });
    expect(h.showCard).toHaveBeenCalledTimes(1);
    expect(h.showCard.mock.calls[0]![0].top_fix).toBeNull();
    expect(h.ctl.state).toBe('summary'); // Retry and See full report are live
  });

  it('the_room_closing_after_the_round_is_not_an_error', async () => {
    const h = harness();
    const t = await live(h);
    await scoring(h, t);
    const errors = errorsOf(h);
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    await vi.waitFor(() => expect(h.ctl.state).toBe('summary'));
    h.socket.terminal(4409);
    expect(errors).toEqual([]);
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(null);

    // Closed before report.ready arrived: read the report anyway.
    const h2 = harness();
    const t2 = await live(h2);
    await scoring(h2, t2);
    const errors2 = errorsOf(h2);
    h2.socket.terminal(4409);
    await vi.waitFor(() => expect(h2.xr.ui.showSummary).toHaveBeenCalledWith(REPORT));
    expect(errors2).toEqual([]);
  });

  it('a_scorecard_that_beats_the_goodbye_still_ends_on_the_summary', async () => {
    const h = harness();
    const t = await live(h);
    const states: string[] = [];
    h.ctl.on('state', (s) => states.push(s));
    const errors = errorsOf(h);
    h.ui('end');
    t.mode('speaking'); // the goodbye is still playing here when the server closes the round
    h.socket.serverSend('round.ended', { reason: 'user_ended' });
    h.socket.serverSend('report.progress', { stage: 'card', pct: 50, card: CARD });
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    h.socket.terminal(4409);
    await vi.waitFor(() => expect(h.xr.ui.showSummary).toHaveBeenCalledWith(REPORT));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.stopped).toBe(true);
    expect(h.showCard).toHaveBeenCalledWith(CARD);
    expect(h.ctl.state).toBe('summary');
    expect(states.at(-1)).toBe('summary');
    expect(states.filter((s) => s === 'summary')).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(h.api.endSession).not.toHaveBeenCalled(); // the server ended it itself
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(null);
  });

  it('the_interviewer_ending_the_round_itself_gets_no_second_goodbye', async () => {
    const h = harness();
    const t = await live(h);
    t.mode('speaking');
    t.agent('a5', 'Thanks, that is all from me. Your scorecard is next.');
    h.socket.serverSend('round.ending', { closing_line: 'Thanks, that is all from me.' });
    expect(h.ctl.state).toBe('ending');
    expect(t.sentEvents).toEqual([]); // no [event: ending]: the closing line is already playing
    expect(t.stopped).toBe(false);
    t.mode('listening'); // the line is over
    await vi.waitFor(() => expect(h.ctl.state).toBe('scoring'));
    expect(t.stopped).toBe(true);
    expect(h.api.endSession).not.toHaveBeenCalled(); // the server ends it itself

    // The closing line was short and is already over when the frame arrives: finish after a short grace.
    const h2 = harness();
    const t2 = await live(h2);
    h2.socket.serverSend('round.ending', { closing_line: 'Bye.' });
    expect(t2.sentEvents).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h2.ctl.state).toBe('scoring');
  });

  it('round_ended_during_the_goodbye_lets_the_line_finish_but_not_for_long', async () => {
    const h = harness();
    const t = await live(h);
    h.ui('end');
    t.mode('speaking');
    h.socket.serverSend('round.ended', { reason: 'user_ended' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.stopped).toBe(false); // the goodbye is still playing
    expect(h.ctl.state).toBe('ending');
    t.mode('listening');
    await vi.waitFor(() => expect(h.ctl.state).toBe('scoring'));
    expect(t.stopped).toBe(true);
    // Everyone at the table sits idle through scoring: nobody stays "speaking".
    expect(h.avatars.get('p1')!.modes.at(-1)).toBe('idle');

    // A voice that never goes quiet is stopped 6 s after the server closed the round.
    const h2 = harness();
    const t2 = await live(h2);
    h2.ui('end');
    t2.mode('speaking');
    h2.socket.serverSend('round.ended', { reason: 'user_ended' });
    await vi.advanceTimersByTimeAsync(5_999);
    expect(t2.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(t2.stopped).toBe(true));
    expect(h2.avatars.get('p1')!.modes.at(-1)).toBe('idle');

    // The server ends a quiet round (time limit): nothing to wait for.
    const h3 = harness();
    const t3 = await live(h3);
    h3.socket.serverSend('round.ended', { reason: 'time_limit' });
    await vi.waitFor(() => expect(t3.stopped).toBe(true));
    expect(t3.sentEvents).toEqual([]);
  });

  it('the_summary_shows_once_however_many_signals_ask_for_it', async () => {
    const h = harness();
    const t = await live(h);
    await scoring(h, t);
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    h.socket.terminal(4409); // the server closes the room right after report.ready
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    await vi.waitFor(() => expect(h.ctl.state).toBe('summary'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.api.report).toHaveBeenCalledTimes(1);
    expect(h.xr.ui.showSummary).toHaveBeenCalledTimes(1);
  });

  it('a_report_read_that_fails_is_tried_again_before_the_fallback_card', async () => {
    const h = harness();
    const t = await live(h);
    await scoring(h, t);
    const errors = errorsOf(h);
    h.api.report.mockRejectedValueOnce(new Error('502')).mockRejectedValueOnce(new Error('502'));
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(h.xr.ui.showSummary).toHaveBeenCalledWith(REPORT));
    expect(h.api.report).toHaveBeenCalledTimes(3);
    expect(h.showCard).not.toHaveBeenCalled();
    expect(errors).toEqual([]);

    // It never comes: the fallback card, after the retries.
    const h2 = harness();
    const t2 = await live(h2);
    await scoring(h2, t2);
    h2.api.report.mockRejectedValue(new Error('502'));
    h2.socket.serverSend('report.ready', { session_id: 'sess1' });
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.waitFor(() => expect(h2.ctl.state).toBe('summary'));
    expect(h2.api.report).toHaveBeenCalledTimes(4);
    expect(h2.showCard).toHaveBeenCalledTimes(1);
    expect(h2.showCard.mock.calls[0]![1]).toEqual({ pending: false });
  });

  it('a_failed_report_takes_the_almost_ready_line_off_the_quick_card', async () => {
    const h = harness();
    const t = await live(h);
    await scoring(h, t);
    h.socket.serverSend('report.progress', { stage: 'card', pct: 50, card: CARD });
    h.socket.serverSend('error', { code: 'report_failed', message: 'scoring gave up' });
    expect(h.showCard).toHaveBeenLastCalledWith(CARD, { pending: false });
    expect(h.ctl.state).toBe('summary');
  });

  it('progress_is_a_percentage_even_when_it_is_one', async () => {
    const h = harness();
    const t = await live(h);
    await scoring(h, t);
    h.socket.serverSend('report.progress', { stage: 'metrics', pct: 1 });
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith('Writing your scorecard', 0.01);
  });

  it('dispose_leaves_no_timer_behind', async () => {
    const h = harness();
    const t = await live(h);
    t.user('s1', 'So', false); // arms the stale segment and the turn timers
    await h.ctl.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
