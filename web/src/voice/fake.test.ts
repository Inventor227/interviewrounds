import { describe, expect, it, vi } from 'vitest';
import type { VoiceMode } from '../shared/types';
import { FakeTransport, readSse, type Speaker } from './fake';
import { panelist } from './testkit';
import type { AgentText, UserTranscript, VoiceError } from './transport';

const enc = new TextEncoder();

function sse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

class InstantSpeaker implements Speaker {
  spoken: { text: string; rate: number }[] = [];
  cancelled = 0;
  async speak(text: string, rate: number, onStart: () => void): Promise<void> {
    this.spoken.push({ text, rate });
    onStart();
  }
  cancel(): void {
    this.cancelled++;
  }
}

function setup(responses: Response[]) {
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => responses.shift() ?? sse([chunk('', 'stop')]));
  const speaker = new InstantSpeaker();
  const t = new FakeTransport(panelist('p1', 0), {
    sessionId: 'sess1',
    clientToken: 'tok1',
    rate: 1.1,
    fetch: fetchFn as unknown as typeof fetch,
    speaker,
  });
  const modes: VoiceMode[] = [];
  const users: UserTranscript[] = [];
  const texts: AgentText[] = [];
  const errors: VoiceError[] = [];
  t.on('mode', (m) => modes.push(m));
  t.on('userTranscript', (u) => users.push(u));
  t.on('agentText', (a) => texts.push(a));
  t.on('error', (e) => errors.push(e));
  return { t, fetchFn, speaker, modes, users, texts, errors };
}

describe('readSse', () => {
  it('joins data lines split across chunks', async () => {
    const res = sse(['data: {"a"', ':1}\n\nda', 'ta: [DONE]\n\n']);
    const out: string[] = [];
    for await (const d of readSse(res.body!)) out.push(d);
    expect(out).toEqual(['{"a":1}', '[DONE]']);
  });
});

describe('FakeTransport', () => {
  it('posts_a_typed_turn_with_the_client_token_and_speaks_the_reply', async () => {
    const s = setup([sse([chunk('Hel'), chunk('lo there. How'), chunk(' are you?'), chunk('', 'stop'), 'data: [DONE]\n\n'])]);
    await s.t.start();
    s.t.sendText('My answer');
    await vi.waitFor(() => expect(s.modes.at(-1)).toBe('listening'));

    expect(s.users).toEqual([{ segmentId: expect.any(String), text: 'My answer', final: true }]);
    const [url, init] = s.fetchFn.mock.calls[0]!;
    expect(url).toBe('/v1/chat/completions');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok1');
    const body = JSON.parse(String(init!.body));
    expect(body.stream).toBe(true);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'My answer' });
    expect(body.fishaudio_extra_body).toEqual({ session_id: 'sess1', panelist_id: 'p1' });

    expect(s.speaker.spoken.map((x) => x.text)).toEqual(['Hello there.', 'How are you?']);
    expect(s.speaker.spoken[0]!.rate).toBe(1.1);
    expect(s.modes).toEqual(['listening', 'thinking', 'speaking', 'listening']);
    expect(s.texts.at(-1)?.text).toBe('Hello there. How are you?');
    expect(new Set(s.texts.map((x) => x.segmentId)).size).toBe(1);
  });

  it('keeps_history_and_sends_markers_without_a_transcript', async () => {
    const s = setup([sse([chunk('Welcome.', 'stop')]), sse([chunk('Go on.', 'stop')])]);
    await s.t.start();
    s.t.sendEvent('[event: start]');
    await vi.waitFor(() => expect(s.fetchFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(s.modes.at(-1)).toBe('listening'));
    expect(s.users).toEqual([]);
    s.t.sendText('Hi');
    await vi.waitFor(() => expect(s.fetchFn).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(s.fetchFn.mock.calls[1]![1]!.body));
    expect(body.messages).toEqual([
      { role: 'user', content: '[event: start]' },
      { role: 'assistant', content: 'Welcome.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('reports_endpoint_errors_and_returns_to_listening', async () => {
    const s = setup([new Response('{"code":"unauthorized"}', { status: 401 })]);
    await s.t.start();
    s.t.sendText('hello');
    await vi.waitFor(() => expect(s.errors).toHaveLength(1));
    expect(s.errors[0]!.code).toBe('llm_failed');
    expect(s.modes.at(-1)).toBe('listening');
  });

  it('speaks_the_opening_line_on_start', async () => {
    const speaker = new InstantSpeaker();
    const t = new FakeTransport(panelist('p2', 1), {
      sessionId: 's',
      clientToken: 'k',
      fetch: vi.fn() as unknown as typeof fetch,
      speaker,
      openingLine: 'Hi, I am Priya.',
    });
    const texts: AgentText[] = [];
    t.on('agentText', (a) => texts.push(a));
    await t.start();
    await vi.waitFor(() => expect(speaker.spoken.map((x) => x.text)).toEqual(['Hi, I am Priya.']));
    expect(texts.at(-1)?.text).toBe('Hi, I am Priya.');
  });

  it('stop_cancels_speech_and_emits_ended', async () => {
    const s = setup([]);
    const ended = vi.fn();
    s.t.on('ended', ended);
    await s.t.start();
    await s.t.stop();
    expect(s.speaker.cancelled).toBeGreaterThan(0);
    expect(ended).toHaveBeenCalledWith({ reason: 'user_hangup' });
    expect(s.t.outputStream()).toBeNull();
  });
});
