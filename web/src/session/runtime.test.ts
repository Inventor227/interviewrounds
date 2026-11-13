import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../shared/types';
import { sessionRes } from '../voice/testkit';
import type { XRVisibilityLike } from './ports';

// The runtime's own wiring, with the heavy parts (the XR world, the avatars, the socket) replaced by small fakes.

const fake = vi.hoisted(() => {
  class Socket {
    static all: Socket[] = [];
    listeners = new Map<string, Set<(d: unknown) => void>>();
    closed = false;
    constructor(
      readonly url: string,
      readonly token: string,
    ) {
      Socket.all.push(this);
    }
    on(t: string, cb: (d: unknown) => void) {
      let set = this.listeners.get(t);
      if (!set) this.listeners.set(t, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    }
    count() {
      return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
    }
    server(t: string, d: unknown) {
      for (const cb of [...(this.listeners.get(t) ?? [])]) cb(d);
    }
    connect = async () => undefined;
    send() {}
    close() {
      this.closed = true;
    }
  }
  return { Socket, me: null as unknown, app: null as unknown };
});

vi.mock('../net/ws', () => ({ SessionSocket: fake.Socket }));
vi.mock('../app/components/data', () => ({ loadMe: async () => fake.me, setMe: vi.fn() }));
vi.mock('../xr/avatar', () => ({
  manifestEntry: async () => ({}),
  Avatar: {
    load: async () => ({ root: { visible: false }, place() {}, setMode() {}, lookAt() {}, pointAt() {}, attachVoice: async () => undefined, setUserSpeaking() {}, update() {}, dispose() {} }),
  },
}));
vi.mock('../xr/avatar/lipsync', () => ({ preloadVisemeModel: async () => undefined }));
vi.mock('../xr/world', () => ({ createXRApp: async () => fake.app }));

function fakeApp() {
  const vis = new Set<(v: XRVisibilityLike) => void>();
  const ends = new Set<(e: { byApp: boolean }) => void>();
  const played: string[] = [];
  const app = {
    world: { session: undefined as unknown },
    played,
    room: { setWallboardVisible: vi.fn(), seatPoses: () => [], root: { add: vi.fn() }, sheet: { visible: false } },
    ui: {
      captions: { setEnabled: vi.fn() },
      roundBar: { setCaptions: vi.fn() },
      layoutBriefBeyondSheet: vi.fn(),
      onAction: () => () => undefined,
      setRoundState: vi.fn(),
      showSummary: vi.fn(),
      showQuickCard: vi.fn(),
      setStatus: vi.fn(),
      showStatusText: vi.fn(),
      hideStatus: vi.fn(),
      setNotice: vi.fn(),
      setPaused: vi.fn(),
      setCaption: vi.fn(),
    },
    sounds: { play: (n: string) => void played.push(n), setVolume: vi.fn(), click: vi.fn() },
    onSessionEnd: (cb: (e: { byApp: boolean }) => void) => (ends.add(cb), () => ends.delete(cb)),
    onVisibility: (cb: (v: XRVisibilityLike) => void) => (vis.add(cb), () => vis.delete(cb)),
    onFrame: () => () => undefined,
    onSelect: () => () => undefined,
    desk: () => null,
    headPose: () => ({ pos: { x: 0, y: 1.2, z: 0 }, yaw: 0, pitch: 0 }),
    sceneChanged: vi.fn(),
    enter: vi.fn(async () => undefined),
    exit: vi.fn(),
    place: vi.fn(async () => ({})),
    destroy: vi.fn(),
    visibility: (v: XRVisibilityLike) => vis.forEach((cb) => cb(v)),
    sessionEnd: (byApp: boolean) => ends.forEach((cb) => cb({ byApp })),
  };
  return app;
}

const ME = { onboarding_done: true, settings: { captions: true, sfx_volume: 0.6, dominant_hand: 'right', voice_speed: 1 } } as unknown as Me;

async function ready(opts: { preview?: boolean; me?: Me | null } = {}) {
  const app = fakeApp();
  fake.app = app;
  fake.me = opts.me === undefined ? ME : opts.me;
  const { createRoundRuntime, sessionIdOf, START_CUE_MS } = await import('./runtime');
  const { liveRoom } = await import('./room');
  const deps = createRoundRuntime({ preview: opts.preview ?? false });
  const res = sessionRes(); // no board in this round
  await deps.xr.preload!(res);
  return { app, deps, res, sessionIdOf, START_CUE_MS, room: liveRoom()! };
}

describe('the round runtime', () => {
  beforeEach(() => {
    fake.Socket.all.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the_session_id_is_read_from_the_socket_path', async () => {
    const { sessionIdOf, deps } = await ready();
    expect(sessionIdOf('/ws/session/9f0c-ab')).toBe('9f0c-ab');
    expect(sessionIdOf('/ws/session/abc?x=1')).toBe('abc');
    expect(sessionIdOf('wss://rounds.example/ws/session/abc#frag')).toBe('abc');
    expect(sessionIdOf('/ws/other/abc')).toBeNull();
    deps.xr.dispose!();
  });

  it('the_start_cue_plays_the_chime_once_and_takes_as_long_as_the_chime', async () => {
    const { app, deps, START_CUE_MS } = await ready();
    deps.makeSocket('/ws/session/sess1', 'tok1');
    vi.useFakeTimers();
    let over = false;
    void deps.xr.startCue!().then(() => (over = true));
    expect(app.played).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(START_CUE_MS - 1);
    expect(over).toBe(false); // the mic stays closed for the whole chime
    await vi.advanceTimersByTimeAsync(1);
    expect(over).toBe(true);
    // Asked again in the same round (a second enter): no second chime.
    void deps.xr.startCue!();
    expect(app.played).toEqual(['start']);
    deps.xr.dispose!();
  });

  it('with_sounds_off_the_start_cue_is_over_at_once', async () => {
    const { app, deps } = await ready({ me: { ...ME, settings: { ...ME.settings, sfx_volume: 0 } } });
    deps.makeSocket('/ws/session/sess1', 'tok1');
    let over = false;
    void deps.xr.startCue!().then(() => (over = true));
    await Promise.resolve();
    expect(over).toBe(true);
    expect(app.played).toEqual([]);
    deps.xr.dispose!();
  });

  it('in_session_follows_the_headset_session_and_is_always_true_in_the_preview', async () => {
    const { app, deps } = await ready();
    expect(deps.xr.inSession!()).toBe(false);
    app.world.session = {};
    expect(deps.xr.inSession!()).toBe(true);
    app.world.session = undefined; // the system ended it
    expect(deps.xr.inSession!()).toBe(false);
    deps.xr.dispose!();
    const p = await ready({ preview: true });
    expect(p.deps.xr.inSession!()).toBe(true);
    p.deps.xr.dispose!();
  });

  it('a_session_made_again_moves_the_cues_and_the_pointing_to_the_new_socket', async () => {
    const { app, deps } = await ready();
    deps.makeSocket('/ws/session/a', 'tok-a');
    const a = fake.Socket.all[0]!;
    expect(a.count()).toBeGreaterThan(0);
    deps.makeSocket('/ws/session/b', 'tok-b');
    const b = fake.Socket.all[1]!;
    expect(a.count()).toBe(0); // nothing of the room listens to the old socket any more
    expect(b.count()).toBeGreaterThan(0);
    const state = { status: 'live', floor: 'p1', elapsed_s: 5, time_check_due: false };
    b.server('round.state', state);
    b.server('round.state', { ...state, time_check_due: true });
    expect(app.played).toEqual(['tick']);
    a.server('round.state', { ...state, time_check_due: true });
    expect(app.played).toEqual(['tick']);
    deps.xr.dispose!();
    expect(b.count()).toBe(0);
  });

  it('headset_visibility_and_the_session_end_reach_the_controller_and_the_page', async () => {
    const { app, deps, room } = await ready();
    const seen: string[] = [];
    deps.xr.onVisibility!((v) => seen.push(v));
    deps.xr.onSessionEnd!((e) => seen.push(`end:${e.byApp}:${room.sessionLost}`));
    let changes = 0;
    room.onChange(() => changes++);
    app.visibility('hidden');
    app.visibility('visible');
    app.sessionEnd(true); // our own exit (End): the page does not offer a way back
    expect(room.sessionLost).toBe(false);
    app.sessionEnd(false); // the system ended it
    // The controller hears first (it pauses the round), then the page learns the view is gone.
    expect(seen).toEqual(['hidden', 'visible', 'end:true:false', 'end:false:false']);
    expect(room.sessionLost).toBe(true);
    expect(changes).toBe(1);
    deps.xr.dispose!();
  });

  it('the_pause_and_resume_tones_play_at_the_press_and_no_other_cue_plays_while_paused', async () => {
    const { app, deps } = await ready();
    deps.makeSocket('/ws/session/a', 'tok-a');
    const so = fake.Socket.all[0]!;
    const state = { status: 'live', floor: 'p1', elapsed_s: 5, time_check_due: false };
    so.server('round.state', state);
    deps.xr.ui.setPaused!(true);
    deps.xr.cue!('pause');
    expect(app.ui.setPaused).toHaveBeenCalledWith(true);
    so.server('round.state', { ...state, time_check_due: true }); // a time check falls due during the pause
    so.server('round.state', { ...state, floor: 'p2' });
    expect(app.played).toEqual(['pause']);
    deps.xr.ui.setPaused!(false);
    deps.xr.cue!('resume');
    so.server('round.state', { ...state, floor: 'p1' });
    expect(app.played).toEqual(['pause', 'resume', 'handover']);
    deps.xr.dispose!();
  });

  it('no_board_no_onboarding', async () => {
    const { deps } = await ready({ me: { ...ME, onboarding_done: false } });
    await expect(deps.xr.onboard!()).resolves.toBe('none');
    deps.xr.dispose!();
  });
});
