import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMsgMap,
  ClientMsgType,
  CreateSessionReq,
  Panelist,
  Report,
  ServerMsgMap,
  ServerMsgType,
} from '../shared/types';
import { ScriptedTransport, sessionRes } from '../voice/testkit';
import { VoiceError, type TransportOptions } from '../voice/transport';
import { RoundController, type RoundControllerDeps } from './controller';
import type { AvatarPort, HeadSamplerPort, SocketPort, UiAction, VisibilityPort, XRPort } from './ports';

class FakeSocket implements SocketPort {
  sent: { t: string; d: Record<string, unknown> }[] = [];
  private handlers = new Map<string, Set<(d: never) => void>>();
  constructor(private readonly log: string[]) {}
  async connect(): Promise<void> {
    this.log.push('socket.connect');
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

function harness(opts: { mode?: 'interview' | 'meeting'; voice?: 'fish' | 'fake'; panelMode?: 'swap' | 'joined' } = {}) {
  const log: string[] = [];
  const transports: ScriptedTransport[] = [];
  const socket = new FakeSocket(log);
  const visibility = new FakeVisibility();
  let uiAction: ((a: UiAction) => void) | null = null;
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
    ui: {
      setRoundState: vi.fn(),
      showSummary: vi.fn(),
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
      return sessionRes({ panel_mode: opts.panelMode ?? 'swap' });
    }),
    joinPanelist: vi.fn(async () => ({ voice: { transport: 'fake' as const } })),
    endSession: vi.fn(async () => void log.push('api.endSession')),
    report: vi.fn(async () => REPORT),
  };
  const media = {
    getMic: vi.fn(async () => {
      log.push('media.getMic');
      return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    }),
    resumeAudio: vi.fn(async () => void log.push('media.resumeAudio')),
  };
  const deps: RoundControllerDeps = {
    api,
    makeSocket: () => socket,
    makeTransport: (p: Panelist, o?: TransportOptions) => {
      const t = new ScriptedTransport(p.panelist_id, log, o, p);
      transports.push(t);
      return t;
    },
    xr,
    avatars: avatarFor,
    board: { onActivity: (cb) => (boardCbs.add(cb), () => boardCbs.delete(cb)) },
    head,
    media,
    visibility,
    timing: { silenceWaitSeconds: 20, interruptAfterSeconds: 10 },
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
    board: () => boardCbs.forEach((cb) => cb()),
    ui: (a: UiAction) => uiAction?.(a),
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
    vi.advanceTimersByTime(1_100);
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
    expect(h.xr.ui.setStatus).toHaveBeenLastCalledWith(expect.any(String), 40);
    h.socket.serverSend('report.ready', { session_id: 'sess1' });
    await vi.waitFor(() => expect(h.xr.ui.showSummary).toHaveBeenCalledWith(REPORT));
    expect(states).toEqual(['ending', 'scoring', 'summary']);
  });
});
