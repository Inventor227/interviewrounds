import { describe, expect, it, vi } from 'vitest';
import type { VoiceMode } from '../shared/types';
import { FishTransport, toSessionToken, type FishSessionLike, type FishStartOptions } from './fish';
import { panelist } from './testkit';
import type { AgentText, UserTranscript, VoiceError } from './transport';

// The shape the server sends: Fish's session response, passed through unchanged.
const SERVER_FISH = {
  session_id: 'c0a8012e-7f1b-4c53-9a35-5a3f2b6d9e10',
  token: 'eyJhbGciOiJIUzI1NiJ9.e30.sig',
  livekit_url: 'wss://rtc.fish.example',
  expires_at: '2026-11-13T12:45:00Z',
  max_duration_seconds: 1800,
  transport: 'livekit',
};
const voice = { transport: 'fish' as const, fish: SERVER_FISH };

function setup() {
  let opts: FishStartOptions | null = null;
  const session: FishSessionLike & { calls: string[] } = {
    calls: [],
    sendUserMessage: vi.fn((text: string, o?: { audio?: boolean }) => void session.calls.push(`msg:${text}:${o?.audio}`)),
    sendUserActivity: vi.fn(),
    interrupt: vi.fn(),
    setMicMuted: vi.fn(async (m: boolean) => void session.calls.push(`mute:${m}`)),
    end: vi.fn(async () => void session.calls.push('end')),
    startAudio: vi.fn(async () => void session.calls.push('startAudio')),
    getRoom: () => undefined,
  };
  const start = vi.fn(async (o: FishStartOptions) => {
    opts = o;
    return session;
  });
  const t = new FishTransport(panelist('p1', 0, voice), { start });
  const modes: VoiceMode[] = [];
  const users: UserTranscript[] = [];
  const texts: AgentText[] = [];
  const errors: VoiceError[] = [];
  t.on('mode', (m) => modes.push(m));
  t.on('userTranscript', (u) => users.push(u));
  t.on('agentText', (a) => texts.push(a));
  t.on('error', (e) => errors.push(e));
  return { t, session, start, cb: () => opts!.callbacks!, opts: () => opts!, modes, users, texts, errors };
}

describe('FishTransport', () => {
  it('builds_a_livekit_token_from_the_panelist_voice', () => {
    // The server's object goes to the SDK whole.
    expect(toSessionToken(SERVER_FISH)).toEqual(SERVER_FISH);
    // Fish may leave fields out or send the deadline as a number; extra fields ride along.
    expect(toSessionToken({ session_id: 's', token: 't', livekit_url: 'wss://x', expires_at: 1794560000, region: 'eu' })).toEqual({
      transport: 'livekit',
      session_id: 's',
      token: 't',
      livekit_url: 'wss://x',
      expires_at: '1794560000',
      max_duration_seconds: 0,
      region: 'eu',
    });
  });

  it('maps_sdk_events_and_drops_marker_echoes', async () => {
    const s = setup();
    await s.t.start();
    expect(s.opts().sessionToken).toEqual(SERVER_FISH); // the server's object, whole
    s.cb().onModeChange?.('thinking');
    s.cb().onUserTranscript?.({ segmentId: 'typed_1', text: '[event: start]', final: true });
    s.cb().onUserTranscript?.({ segmentId: 'u1', text: 'I think', final: false });
    s.cb().onAgentResponseDelta?.({ segmentId: 'a1', delta: 'Sure', text: 'Sure' });
    expect(s.modes).toEqual(['thinking']);
    expect(s.users).toEqual([{ segmentId: 'u1', text: 'I think', final: false }]);
    expect(s.texts).toEqual([{ segmentId: 'a1', delta: 'Sure', text: 'Sure' }]);
  });

  it('sends_markers_as_spoken_turns_and_gates_the_mic', async () => {
    const s = setup();
    await s.t.start();
    s.t.sendEvent('[event: start]');
    s.t.setMicMuted(true);
    s.t.noteActivity();
    s.t.interrupt();
    expect(s.session.calls).toEqual(['msg:[event: start]:true', 'mute:true']);
    expect(s.session.sendUserActivity).toHaveBeenCalled();
    expect(s.session.interrupt).toHaveBeenCalled();
  });

  it('maps_mic_denial_to_a_typed_error', async () => {
    const s = setup();
    s.start.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'mic_permission_denied' }));
    await expect(s.t.start()).rejects.toMatchObject({ name: 'VoiceError', code: 'mic_denied' });
  });

  it('reports_disconnects_as_ended_and_errors_as_voice_errors', async () => {
    const s = setup();
    const ended = vi.fn();
    s.t.on('ended', ended);
    await s.t.start();
    s.cb().onError?.(Object.assign(new Error('llm down'), { code: 'provider_error' }) as never);
    s.cb().onDisconnect?.({ reason: 'llm_endpoint_failure' });
    expect(s.errors[0]!.code).toBe('provider_error');
    expect(ended).toHaveBeenCalledWith({ reason: 'llm_endpoint_failure' });
    await s.t.stop();
    expect(s.session.end).not.toHaveBeenCalled(); // already over
  });

  it('stop_ends_a_live_session_once', async () => {
    const s = setup();
    await s.t.start();
    await s.t.stop();
    await s.t.stop();
    expect(s.session.end).toHaveBeenCalledTimes(1);
  });

  it('stop_during_start_ends_the_session_once_connected', async () => {
    const s = setup();
    let connect!: () => void;
    s.start.mockImplementationOnce(async (o: FishStartOptions) => {
      await new Promise<void>((r) => (connect = r));
      void o;
      return s.session;
    });
    const starting = s.t.start();
    await vi.waitFor(() => expect(connect).toBeTypeOf('function'));
    await s.t.stop();
    expect(s.session.end).not.toHaveBeenCalled();
    connect();
    await starting;
    expect(s.session.end).toHaveBeenCalledTimes(1);
    s.t.sendEvent('[event: start]');
    expect(s.session.sendUserMessage).not.toHaveBeenCalled();
  });

  it('muted_before_start_publishes_no_mic', async () => {
    const s = setup();
    s.t.setMicMuted(true);
    await s.t.start();
    expect(s.opts().microphone).toBe(false);
    const u = setup();
    await u.t.start();
    expect(u.opts().microphone).toBe(true);
  });

  it('exposes_start_audio_for_blocked_playback', async () => {
    const s = setup();
    await s.t.start();
    await s.t.startAudio();
    expect(s.session.startAudio).toHaveBeenCalled();
  });

  it('skips_recovered_provider_errors_and_maps_origin_errors', async () => {
    const s = setup();
    await s.t.start();
    s.cb().onError?.(Object.assign(new Error('blip'), { code: 'provider_error', recovered: true }) as never);
    expect(s.errors).toHaveLength(0);
    s.start.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'origin_forbidden' }));
    const t2 = new FishTransport(panelist('p2', 1, voice), { start: s.start });
    await expect(t2.start()).rejects.toMatchObject({ code: 'connect_failed' });
  });
});
