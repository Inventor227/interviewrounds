import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSessionReq } from '../shared/types';
import { discardLaunch, enterLaunch, launchState, placeholderXr, prepareLaunch, type PrepareInput } from './launch';
import { cleanup, testRuntime, useFakeServer, waitFor } from './test-utils';

const entry = vi.hoisted(() => ({
  handles: [] as { enter: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[],
  gate: null as null | Promise<void>,
}));
vi.mock('../xr/entry', () => ({
  createImmersive: vi.fn(async () => {
    if (entry.gate) await entry.gate;
    const h = { enter: vi.fn(), exit: vi.fn(), destroy: vi.fn() };
    entry.handles.push(h);
    return h;
  }),
}));

const audio = vi.hoisted(() => ({ resume: vi.fn(async () => {}) }));
vi.mock('../voice/audio', () => ({ getAudioContext: () => ({ resume: audio.resume }), resumeAudio: async () => {} }));

const req: CreateSessionReq = { mode: 'interview', round_id: 'sde.system_design.short', length: 'short', level: 'mid', style: 'neutral', voice: 'fake' };
const input: PrepareInput = { kind: 'new', req };
const stream = () => {
  const track = { stop: vi.fn() };
  return { s: { getTracks: () => [track] } as unknown as MediaStream, track };
};

describe('placeholder room', () => {
  beforeEach(() => {
    entry.handles.length = 0;
    entry.gate = null;
  });

  it('dispose_destroys_the_world_and_its_host', async () => {
    const xr = placeholderXr(false, false);
    await xr.preload!();
    expect(document.body.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(1);
    xr.dispose!();
    expect(entry.handles[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);
  });

  it('dispose_during_preload_destroys_the_world_when_it_arrives', async () => {
    let open!: () => void;
    entry.gate = new Promise<void>((r) => (open = r));
    const xr = placeholderXr(false, false);
    const loading = xr.preload!();
    xr.dispose!();
    open();
    await loading;
    expect(entry.handles[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelectorAll('div[aria-hidden="true"]')).toHaveLength(0);
  });
});

describe('launch', () => {
  beforeEach(() => {
    audio.resume.mockClear();
  });
  afterEach(cleanup);

  const posts = (server: ReturnType<typeof useFakeServer>) => server.calls.filter((c) => c.method === 'POST' && c.path === '/api/sessions');

  it('try_again_after_a_failed_preload_posts_only_once', async () => {
    const server = useFakeServer({ scenario: '1' });
    testRuntime.xrPreload.mockRejectedValueOnce(new Error('gl'));
    await prepareLaunch(input, { mic: stream().s, preview: false });
    expect(launchState().status).toBe('failed');
    const first = launchState().status !== 'idle' ? (launchState() as { controller: unknown }).controller : null;
    await prepareLaunch(input, { mic: stream().s, preview: false });
    expect(launchState().status).toBe('ready');
    expect((launchState() as { controller: unknown }).controller).toBe(first);
    expect(posts(server)).toHaveLength(1);
    expect(testRuntime.xrPreload).toHaveBeenCalledTimes(2);
  });

  it('dropping_a_prepared_round_frees_the_room', async () => {
    useFakeServer({ scenario: '1' });
    await prepareLaunch(input, { mic: stream().s, preview: false });
    discardLaunch();
    await waitFor(() => testRuntime.xrDispose.mock.calls.length === 1);
    expect(launchState().status).toBe('idle');
  });

  it('a_discard_while_loading_cancels_the_prepare', async () => {
    const server = useFakeServer({ scenario: '1' });
    const { s, track } = stream();
    const pending = prepareLaunch(input, { mic: s, preview: false });
    discardLaunch(); // the page was left before the code loaded
    await pending;
    expect(launchState().status).toBe('idle');
    expect(posts(server)).toHaveLength(0);
    expect(track.stop).toHaveBeenCalled();
  });

  it('enter_resumes_audio_inside_the_tap', async () => {
    useFakeServer({ scenario: '1' });
    await prepareLaunch(input, { mic: stream().s, preview: false });
    audio.resume.mockClear();
    const route = vi.fn();
    expect(enterLaunch(route)).toBe(true);
    expect(testRuntime.xrEnter).toHaveBeenCalledTimes(1);
    expect(audio.resume).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith('/session/s_new_1');
  });

  it('a_ready_round_that_loses_its_socket_turns_failed', async () => {
    const server = useFakeServer({ scenario: '1' });
    await prepareLaunch(input, { mic: stream().s, preview: false });
    expect(launchState().status).toBe('ready');
    testRuntime.closeSocket(4409);
    expect(launchState().status).toBe('failed');
    // Its session is gone, so another try makes a new one.
    await prepareLaunch(input, { mic: stream().s, preview: false });
    expect(launchState().status).toBe('ready');
    expect(posts(server)).toHaveLength(2);
  });
});
