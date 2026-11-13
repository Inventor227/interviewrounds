import { describe, expect, it, vi } from 'vitest';
import type { VoiceMode } from '../shared/types';
import { FishTransport, toSessionToken, type FishSessionLike, type FishStartOptions } from './fish';
import { panelist } from './testkit';
import type { AgentText, UserTranscript, VoiceError } from './transport';

const voice = { transport: 'fish' as const, fish: { session_token: 'jwt-abc', livekit_url: 'wss://lk.example' } };

function setup() {
  let opts: FishStartOptions | null = null;
  const session: FishSessionLike & { calls: string[] } = {
    calls: [],
    sendUserMessage: vi.fn((text: string, o?: { audio?: boolean }) => void session.calls.push(`msg:${text}:${o?.audio}`)),
    sendUserActivity: vi.fn(),
    interrupt: vi.fn(),
    setMicMuted: vi.fn(async (m: boolean) => void session.calls.push(`mute:${m}`)),
    end: vi.fn(async () => void session.calls.push('end')),
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
    expect(toSessionToken(voice.fish)).toMatchObject({
      transport: 'livekit',
      livekit_url: 'wss://lk.example',
      token: 'jwt-abc',
    });
    const full = { transport: 'livekit', session_id: 'sess_1', expires_at: '2099-01-01T00:00:00Z', max_duration_seconds: 1800, livekit_url: 'wss://x', token: 't' };
    expect(toSessionToken({ session_token: JSON.stringify(full), livekit_url: 'wss://x' })).toEqual(full);
  });

  it('maps_sdk_events_and_drops_marker_echoes', async () => {
    const s = setup();
    await s.t.start();
    expect(s.opts().sessionToken.token).toBe('jwt-abc');
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
});
