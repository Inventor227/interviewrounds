import { afterEach, describe, expect, it, vi } from 'vitest';
import { newRecording, recordController, recordTransport, redact, RoundRecorder, RECORDING_FORMAT } from './recorder';

class FakeWS extends EventTarget {
  sent: unknown[] = [];
  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    super();
  }
  send(data: unknown) {
    this.sent.push(data);
  }
}

describe('round recorder', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it('never_keeps_a_token_or_key', () => {
    const out = redact({ t: 'hello', d: { client_token: 'abc', last_seq: 3, voice: { fish: { token: 'x', session_id: 's1' } }, api_key: 7 } });
    expect(out).toEqual({ t: 'hello', d: { client_token: '[redacted]', last_seq: 3, voice: { fish: { token: '[redacted]', session_id: 's1' } }, api_key: '[redacted]' } });
  });

  it('copies_socket_frames_in_and_out_with_the_hello_token_removed', () => {
    const rec = new RoundRecorder();
    const WS = rec.socketClass(FakeWS as unknown as typeof WebSocket);
    const ws = new WS('wss://rounds.example/ws/session/s1?x=1') as unknown as FakeWS;
    ws.send(JSON.stringify({ t: 'hello', seq: 0, d: { client_token: 'secret-token', last_seq: 0 } }));
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'round.state', seq: 1, d: { status: 'live' } }) }));
    expect(ws.sent).toHaveLength(1); // still sent for real
    const kinds = rec.events.map((e) => e.kind);
    expect(kinds).toEqual(['ws.open', 'ws.out', 'ws.in']);
    expect(JSON.stringify(rec.events)).not.toContain('secret-token');
    expect(rec.events[0]!.url).toBe('wss://rounds.example/ws/session/s1');
    expect(rec.events[2]!.frame).toEqual({ t: 'round.state', seq: 1, d: { status: 'live' } });
  });

  it('times_are_from_the_round_start_and_voice_events_carry_the_panelist', async () => {
    const rec = new RoundRecorder();
    const handlers = new Map<string, (e: unknown) => void>();
    const sent: string[] = [];
    const t = {
      panelistId: 'p1',
      on: (ev: string, cb: (e: never) => void) => {
        handlers.set(ev, cb as (e: unknown) => void);
        return () => undefined;
      },
      sendText: (x: string) => void sent.push(x),
      sendEvent: (x: string) => void sent.push(x),
      outputStream: () => null,
    };
    recordTransport(rec, t);
    const states = new Map<string, (v: unknown) => void>();
    recordController(rec, { state: 'idle', on: (ev, cb) => (states.set(ev, cb as (v: unknown) => void), () => undefined) });
    t.sendEvent('[event: start]');
    states.get('state')!('greeting');
    handlers.get('mode')!('speaking');
    handlers.get('agentText')!({ segmentId: 'a1', delta: 'Hi', text: 'Hi' });
    t.sendText('My answer.');
    expect(sent).toEqual(['[event: start]', 'My answer.']);
    const { timeline } = await rec.finish({ room: 'conference_room' });
    expect(timeline.format).toBe(RECORDING_FORMAT);
    expect(timeline.room).toBe('conference_room');
    const ev = timeline.events as { t: number; kind: string; panelist?: string; text?: string }[];
    const start = ev.find((e) => e.kind === 'round.start')!;
    expect(start.t).toBe(0);
    expect(ev.find((e) => e.kind === 'voice.sent' && e.text === '[event: start]')!.t).toBeLessThanOrEqual(0);
    expect(ev.find((e) => e.kind === 'voice.agent_text')).toMatchObject({ panelist: 'p1', text: 'Hi' });
    expect(ev.find((e) => e.kind === 'voice.sent' && e.text === 'My answer.')!.t).toBeGreaterThanOrEqual(0);
  });

  it('is_off_unless_asked_for', () => {
    expect(newRecording()).toBeNull();
    sessionStorage.setItem('ir_record', '1');
    expect(newRecording()).toBeInstanceOf(RoundRecorder);
  });
});
