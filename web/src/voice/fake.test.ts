import { describe, expect, it, vi } from 'vitest';
import type { VoiceMode } from '../shared/types';
import { BrowserSpeaker, FakeTransport, readSse, RETRY_AFTER_MS, type Speaker } from './fake';
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

describe('BrowserSpeaker', () => {
  it('cancel_leaves_other_speakers_alone', () => {
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { cancel });
    try {
      new BrowserSpeaker().cancel();
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('readSse', () => {
  it('joins data lines split across chunks', async () => {
    const res = sse(['data: {"a"', ':1}\n\nda', 'ta: [DONE]\n\n']);
    const out: string[] = [];
    for await (const d of readSse(res.body!)) out.push(d);
    expect(out).toEqual(['{"a":1}', '[DONE]']);
  });

  it('cancels_the_body_when_left_early', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: [DONE]\n\n'));
      },
      cancel,
    });
    for await (const d of readSse(body)) if (d === '[DONE]') break;
    expect(cancel).toHaveBeenCalled();
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
    expect(s.errors[0]!.code).toBe('session_expired');
    expect(s.modes.at(-1)).toBe('listening');
  });

  it('reports_server_errors_and_sse_error_chunks', async () => {
    const s = setup([new Response('oops', { status: 500 }), sse([chunk('Hel'), 'data: {"error":{"message":"model down"}}\n\n'])]);
    await s.t.start();
    s.t.sendText('one');
    await vi.waitFor(() => expect(s.errors).toHaveLength(1));
    expect(s.errors[0]!.code).toBe('llm_failed');
    s.t.sendText('two');
    await vi.waitFor(() => expect(s.errors).toHaveLength(2));
    expect(s.errors[1]!.message).toBe('model down');
  });

  it('fake_turn_retries_once_on_503', async () => {
    vi.useFakeTimers();
    try {
      // A deploy swaps the container: the first try meets the proxy's 503, the second the new server.
      const s = setup([new Response('swapping', { status: 503 }), sse([chunk('Back again.', 'stop'), 'data: [DONE]\n\n'])]);
      await s.t.start();
      s.t.sendText('hello');
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1);
      expect(s.fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(s.speaker.spoken.map((x) => x.text)).toEqual(['Back again.']));
      expect(s.fetchFn).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(s.fetchFn.mock.calls[1]![1]!.body))).toEqual(JSON.parse(String(s.fetchFn.mock.calls[0]![1]!.body)));
      expect(s.errors).toEqual([]);

      // Twice in a row is a real failure: one retry, then the error.
      const d = setup([new Response('x', { status: 502 }), new Response('x', { status: 504 }), sse([chunk('never', 'stop')])]);
      await d.t.start();
      d.t.sendText('hello');
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
      await vi.waitFor(() => expect(d.errors).toHaveLength(1));
      expect(d.errors[0]!.code).toBe('llm_failed');
      expect(d.fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins_silent_and_says_its_line_on_the_handover_marker', async () => {
    // A swap's new voice: nothing on start; the server answers its hand-over marker with the prepared line.
    const s = setup([sse([chunk('Hi, I am Priya. '), chunk('', 'stop'), 'data: [DONE]\n\n'])]);
    await s.t.start();
    await Promise.resolve();
    expect(s.speaker.spoken).toEqual([]);
    expect(s.fetchFn).not.toHaveBeenCalled();
    s.t.sendEvent('[event: handover]');
    await vi.waitFor(() => expect(s.speaker.spoken.map((x) => x.text)).toEqual(['Hi, I am Priya.']));
    const body = JSON.parse(s.fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.messages).toEqual([{ role: 'user', content: '[event: handover]' }]);
    expect(s.users).toEqual([]); // a marker is not the user's speech
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
