// FakeTransport: the development voice. It plays Fish's part without spending Fish minutes:
// typed turns (and markers) go to our own /v1/chat/completions with the session's client token,
// the SSE reply is spoken with speechSynthesis, and the same transport events come out.
//
// Like Fish, it sends the whole conversation every turn, tags the request with
// `fishaudio_extra_body {session_id, panelist_id}`, paces agentText to speech, and keeps only the
// words actually spoken when the user cuts in.

import type { Panelist, VoiceMode } from '../shared/types';
import { Emitter, VoiceError, type TransportEvents, type VoiceTransport } from './transport';

export interface Speaker {
  /** Speaks one sentence; calls onStart when audio begins and resolves when it ends. */
  speak(text: string, rate: number, onStart: () => void): Promise<void>;
  /** Stops speaking now; pending speak() calls resolve. */
  cancel(): void;
}

export interface FakeTransportOptions {
  sessionId: string;
  clientToken: string;
  /** Speech rate (settings.voice_speed, 0.8 to 1.25). */
  rate?: number;
  /** Swap-mode hand-over line, spoken on start. */
  openingLine?: string;
  endpoint?: string;
  fetch?: typeof fetch;
  speaker?: Speaker;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Turn {
  id: number;
  segmentId: string;
  spoken: string;
  abort: AbortController;
}

/** Yields the `data:` payloads of a server-sent event stream. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? dec.decode() : dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) break;
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
  } finally {
    reader.releaseLock();
  }
}

/** Splits streamed text into whole sentences; the rest waits for more text. */
function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[.!?]+["')\]]*\s+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    const s = buf.slice(last, m.index + m[0].length).trim();
    if (s) sentences.push(s);
    last = m.index + m[0].length;
  }
  return { sentences, rest: buf.slice(last) };
}

/** speechSynthesis, or a silent timer where the page has no speech (tests, headless runs). */
export class BrowserSpeaker implements Speaker {
  private pending = new Set<() => void>();

  constructor(private readonly voiceIndex = 0) {}

  speak(text: string, rate: number, onStart: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      const estimate = Math.max(600, (text.length / 15) * 1000) / rate;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.pending.delete(done);
        resolve();
      };
      this.pending.add(done);
      const synth = globalThis.speechSynthesis;
      if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
        onStart();
        timer = setTimeout(done, estimate);
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      const voices = synth.getVoices().filter((v) => v.lang.startsWith('en'));
      if (voices.length) u.voice = voices[this.voiceIndex % voices.length] ?? null;
      u.onstart = onStart;
      u.onend = done;
      u.onerror = done;
      // Some engines never fire onend; do not hang the turn.
      timer = setTimeout(done, estimate * 2 + 5000);
      synth.speak(u);
    });
  }

  cancel(): void {
    globalThis.speechSynthesis?.cancel();
    for (const done of [...this.pending]) done();
  }
}

export class FakeTransport implements VoiceTransport {
  readonly panelistId: string;
  private readonly events = new Emitter<TransportEvents>();
  private readonly history: ChatMessage[] = [];
  private readonly fetchFn: typeof fetch;
  private readonly speaker: Speaker;
  private readonly rate: number;
  private readonly endpoint: string;
  private mode: VoiceMode | null = null;
  private turn: Turn | null = null;
  private turnSeq = 0;
  private typedSeq = 0;
  private stopped = false;

  constructor(
    panelist: Panelist,
    private readonly opts: FakeTransportOptions,
  ) {
    this.panelistId = panelist.panelist_id;
    this.fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.speaker = opts.speaker ?? new BrowserSpeaker(panelist.seat);
    this.rate = opts.rate ?? 1;
    this.endpoint = opts.endpoint ?? '/v1/chat/completions';
  }

  on<K extends keyof TransportEvents>(event: K, cb: TransportEvents[K]): () => void {
    return this.events.on(event, cb);
  }

  async start(): Promise<void> {
    this.setMode('listening');
    const line = this.opts.openingLine?.trim();
    if (line) void this.reply((async function* () {
      yield line;
    })());
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cutOff(false);
    this.speaker.cancel();
    this.events.emit('ended', { reason: 'user_hangup' });
  }

  /** There is no mic: typed turns come from the dev console. */
  setMicMuted(_muted: boolean): void {}

  sendEvent(marker: string): void {
    this.userTurn(marker);
  }

  sendText(text: string): void {
    const t = text.trim();
    if (!t || this.stopped) return;
    this.events.emit('userTranscript', { segmentId: `typed_${++this.typedSeq}`, text: t, final: true });
    this.userTurn(t);
  }

  interrupt(): void {
    this.cutOff(true);
    this.setMode('listening');
  }

  /** speechSynthesis output cannot be captured, so lip sync falls back to the voice mode. */
  outputStream(): MediaStream | null {
    return null;
  }

  // ---------- internals ----------

  private userTurn(content: string): void {
    if (this.stopped) return;
    this.cutOff(true);
    this.history.push({ role: 'user', content });
    void this.reply(this.stream());
  }

  /** Ends the running turn; with `keep`, the words already spoken stay in the history. */
  private cutOff(keep: boolean): void {
    const t = this.turn;
    if (!t) return;
    this.turn = null;
    t.abort.abort();
    this.speaker.cancel();
    if (keep && t.spoken) this.history.push({ role: 'assistant', content: t.spoken });
  }

  private async *stream(): AsyncGenerator<string> {
    const turn = this.turn;
    if (!turn) return;
    const res = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.clientToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'interview-rounds',
        stream: true,
        stream_options: { include_usage: true },
        messages: this.history.map((m) => ({ ...m })),
        session_id: this.opts.sessionId,
        fishaudio_extra_body: { session_id: this.opts.sessionId, panelist_id: this.panelistId },
      }),
      signal: turn.abort.signal,
    });
    if (!res.ok || !res.body) {
      throw new VoiceError('llm_failed', `The voice endpoint answered ${res.status}`);
    }
    for await (const data of readSse(res.body)) {
      if (data === '[DONE]') return;
      let chunk: { choices?: { delta?: { content?: string | null } }[] };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  /** Speaks a streamed reply sentence by sentence, pacing agentText to speech. */
  private async reply(source: AsyncGenerator<string>): Promise<void> {
    const id = ++this.turnSeq;
    const turn: Turn = { id, segmentId: `agent_${id}`, spoken: '', abort: new AbortController() };
    this.turn = turn;
    const live = () => this.turn === turn && !this.stopped;
    this.setMode('thinking');

    let speaking = Promise.resolve();
    const say = (sentence: string) => {
      speaking = speaking.then(async () => {
        if (!live()) return;
        await this.speaker.speak(sentence, this.rate, () => {
          if (!live()) return;
          this.setMode('speaking');
          const delta = turn.spoken ? ` ${sentence}` : sentence;
          turn.spoken += delta;
          this.events.emit('agentText', { segmentId: turn.segmentId, delta, text: turn.spoken });
        });
      });
    };

    let buf = '';
    try {
      for await (const delta of source) {
        if (!live()) return;
        buf += delta;
        const { sentences, rest } = takeSentences(buf);
        buf = rest;
        sentences.forEach(say);
      }
      if (buf.trim()) say(buf.trim());
      await speaking;
    } catch (err) {
      if (!live()) return; // aborted by a newer turn or stop()
      this.events.emit('error', err instanceof VoiceError ? err : new VoiceError('llm_failed', String(err), err));
    }
    if (!live()) return;
    this.turn = null;
    if (turn.spoken) this.history.push({ role: 'assistant', content: turn.spoken });
    this.setMode('listening');
  }

  private setMode(m: VoiceMode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.events.emit('mode', m);
  }
}
