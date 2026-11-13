// Round recording for video renders (development only, opt in with `?record=1` or sessionStorage `ir_record=1`).
//
// Everything that happens in a round, on one clock: every socket frame in and out (tokens and keys redacted), every
// voice event per panelist (mode, the agent's text as it plays, the user's transcript, typed turns and markers sent),
// avatar modes, the round controller's states and notices, plus marks a script adds (the candidate's synthetic
// speech). Audio: one webm/opus file per panelist voice stream as received (a new file when a panelist gets a new
// stream), the candidate's microphone when a script hands it over, and a mono mix of all of them.
//
// Format: plan/video/raw/FORMAT.md (interview-rounds.recording.v1). Nothing here runs in a production build.

export const RECORDING_FORMAT = 'interview-rounds.recording.v1';

export interface RecEvent {
  /** ms on the recorder's clock (rebased to the round start on export). */
  t: number;
  kind: string;
  [k: string]: unknown;
}

export interface AudioSegment {
  /** Panelist id, 'candidate' or 'mix'. */
  id: string;
  file: string;
  start_ms: number;
  end_ms: number | null;
  mime: string;
  /** Size of the recorded file. */
  bytes?: number;
}

interface LiveSegment extends AudioSegment {
  rec: MediaRecorder;
  chunks: Blob[];
  stream: MediaStream;
  done: Promise<void>;
}

const SECRET_KEY = /token|secret|key|password|authorization|cookie/i;

/** A copy of a frame with every token-like field replaced (the hello's client token, voice tokens). */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && (typeof x === 'string' || typeof x === 'number') ? '[redacted]' : redact(x, depth + 1);
  }
  return out;
}

function parseFrame(data: unknown): unknown {
  if (typeof data !== 'string') return { binary: true };
  try {
    return redact(JSON.parse(data));
  } catch {
    return { text: data.slice(0, 200) };
  }
}

export class RoundRecorder {
  readonly events: RecEvent[] = [];
  private readonly origin = performance.now();
  private readonly epoch = Date.now();
  private roundStart: number | null = null;
  private readonly segments: LiveSegment[] = [];
  private readonly counts = new Map<string, number>();
  private ctx: AudioContext | null = null;
  private mixDest: MediaStreamAudioDestinationNode | null = null;
  private readonly mixed = new Set<MediaStream>();
  private readonly meters: { id: string; an: AnalyserNode; buf: Float32Array<ArrayBuffer>; on: boolean; since: number }[] = [];
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  readonly meta: Record<string, unknown> = {};

  now(): number {
    return Math.round((performance.now() - this.origin) * 10) / 10;
  }

  event(kind: string, data: Record<string, unknown> = {}): void {
    this.events.push({ ...data, t: this.now(), kind });
  }

  /** The round's clock zero (the first time the round greets); later calls are ignored. */
  markRoundStart(): void {
    if (this.roundStart === null) {
      this.roundStart = this.now();
      this.events.push({ t: this.roundStart, kind: 'round.start' });
    }
  }

  /** A WebSocket class for SessionSocket that copies every frame in and out into the timeline. */
  socketClass(base: typeof WebSocket = WebSocket): typeof WebSocket {
    const rec = this;
    return class RecordingWebSocket extends base {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        rec.event('ws.open', { url: String(url).replace(/\?.*$/, '') });
        this.addEventListener('message', (ev) => rec.event('ws.in', { frame: parseFrame(ev.data) }));
        this.addEventListener('close', (ev) => rec.event('ws.close', { code: ev.code }));
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        rec.event('ws.out', { frame: parseFrame(data) });
        super.send(data);
      }
    };
  }

  /** Records a panelist voice stream (and adds it to the mix). The same stream twice is recorded once. */
  attachAudio(id: string, stream: MediaStream): void {
    if (this.segments.some((s) => s.stream === stream && s.end_ms === null)) return;
    // A new stream for the same panelist ends the previous file.
    for (const s of this.segments) if (s.id === id && s.end_ms === null) this.stopSegment(s);
    const seg = this.startSegment(id, stream);
    if (seg) this.event('audio.start', { id, file: seg.file });
    this.mix(stream, id);
  }

  private startSegment(id: string, stream: MediaStream): LiveSegment | null {
    if (typeof MediaRecorder === 'undefined' || !stream.getAudioTracks().length) return null;
    const n = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, n);
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined);
    } catch (e) {
      this.event('audio.error', { id, message: String(e) });
      return null;
    }
    const chunks: Blob[] = [];
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => resolve();
    const seg: LiveSegment = { id, file: `${id}-${n}.webm`, start_ms: this.now(), end_ms: null, mime: rec.mimeType || 'audio/webm', rec, chunks, stream, done };
    rec.start(1000);
    this.segments.push(seg);
    return seg;
  }

  private stopSegment(s: LiveSegment): void {
    if (s.end_ms !== null) return;
    s.end_ms = this.now();
    try {
      if (s.rec.state !== 'inactive') s.rec.stop();
      else s.rec.onstop?.(new Event('stop'));
    } catch {
      // already stopped
    }
  }

  /**
   * Audible on and off per stream, from its level (RMS over -45 dBFS for 60 ms is on, under it for 400 ms is off):
   * when a voice really starts and stops, independent of the text events.
   */
  private meter(id: string, src: MediaStreamAudioSourceNode): void {
    const an = src.context.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    this.meters.push({ id, an, buf: new Float32Array(an.fftSize), on: false, since: -1 });
    this.meterTimer ??= setInterval(() => {
      const now = this.now();
      for (const m of this.meters) {
        m.an.getFloatTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) sum += m.buf[i]! * m.buf[i]!;
        const loud = Math.sqrt(sum / m.buf.length) > 0.0056;
        if (loud === m.on) {
          m.since = -1;
          continue;
        }
        if (m.since < 0) m.since = now;
        if (now - m.since >= (loud ? 60 : 400)) {
          m.on = loud;
          // The change happened when it began, not when it was confirmed.
          this.events.push({ t: m.since, kind: loud ? 'audio.on' : 'audio.off', id: m.id });
          m.since = -1;
        }
      }
    }, 20);
  }

  private mix(stream: MediaStream, id = 'mix'): void {
    if (this.mixed.has(stream) || !stream.getAudioTracks().length) return;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.mixDest = this.ctx.createMediaStreamDestination();
        this.mixDest.channelCount = 1;
        void this.ctx.resume().catch(() => undefined);
        const seg = this.startSegment('mix', this.mixDest.stream);
        if (seg) this.event('audio.start', { id: 'mix', file: seg.file, context: this.ctx.state });
      }
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.mixDest!);
      this.mixed.add(stream);
      this.meter(id, src);
    } catch (e) {
      this.event('audio.error', { id: 'mix', message: String(e) });
    }
  }

  /** Stops every recording and returns the timeline (rebased to the round start) and the audio segments. */
  async finish(extra: Record<string, unknown> = {}): Promise<{ timeline: Record<string, unknown>; audio: AudioSegment[] }> {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    for (const s of this.segments) this.stopSegment(s);
    await Promise.all(this.segments.map((s) => Promise.race([s.done, new Promise<void>((r) => setTimeout(r, 3000))])));
    const zero = this.roundStart ?? 0;
    const shift = (t: number | null) => (t === null ? null : Math.round((t - zero) * 10) / 10);
    const audio = this.segments.map(({ id, file, start_ms, end_ms, mime, chunks }) => ({
      id,
      file,
      start_ms: shift(start_ms)!,
      end_ms: shift(end_ms),
      mime,
      bytes: chunks.reduce((n, c) => n + c.size, 0),
    }));
    const timeline = {
      format: RECORDING_FORMAT,
      ...this.meta,
      ...extra,
      clock: {
        origin: 'round_start',
        round_start_epoch_ms: Math.round(this.epoch + zero),
        recorder_start_ms: shift(0),
        round_started: this.roundStart !== null,
      },
      audio,
      events: this.events.map((e) => ({ ...e, t: shift(e.t) })).sort((a, b) => a.t! - b.t!),
    };
    return { timeline, audio };
  }

  /** One finished audio file as base64 (call after finish()). */
  async audioBase64(file: string): Promise<string | null> {
    const s = this.segments.find((x) => x.file === file);
    if (!s) return null;
    const buf = new Uint8Array(await new Blob(s.chunks, { type: s.mime }).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }
}

let current: RoundRecorder | null | undefined;

/** The recorder of this page when recording is on (development builds only), else null. */
export function recorder(): RoundRecorder | null {
  if (!import.meta.env.DEV) return null;
  if (current !== undefined) return current;
  let on = false;
  try {
    on = new URLSearchParams(location.search).get('record') === '1' || sessionStorage.getItem('ir_record') === '1';
  } catch {
    on = false;
  }
  current = on ? new RoundRecorder() : null;
  if (current) (globalThis as { __recorder?: RoundRecorder }).__recorder = current;
  return current;
}

/** Starts a fresh recorder (a second round in the same tab); null when recording is off. */
export function newRecording(): RoundRecorder | null {
  if (!import.meta.env.DEV) return null;
  current = undefined;
  return recorder();
}

/** The slice of a voice transport the recorder listens to. */
interface TransportLike {
  readonly panelistId: string;
  on(event: string, cb: (e: never) => void): () => void;
  sendText(text: string): void;
  sendEvent(marker: string): void;
  outputStream(): MediaStream | null;
}

/** Copies one panelist's voice events into the timeline and records its audio once the stream exists. */
export function recordTransport(rec: RoundRecorder, t: TransportLike): void {
  const id = t.panelistId;
  const grab = () => {
    const s = t.outputStream();
    if (s) rec.attachAudio(id, s);
  };
  t.on('mode', ((mode: string) => {
    rec.event('voice.mode', { panelist: id, mode });
    grab();
  }) as (e: never) => void);
  t.on('agentText', ((e: { segmentId: string; delta: string; text: string }) =>
    rec.event('voice.agent_text', { panelist: id, segment: e.segmentId, delta: e.delta, text: e.text })) as (e: never) => void);
  t.on('userTranscript', ((e: { segmentId: string; text: string; final: boolean }) =>
    rec.event('voice.user_transcript', { panelist: id, segment: e.segmentId, text: e.text, final: e.final })) as (e: never) => void);
  t.on('ended', ((e: { reason: string }) => rec.event('voice.ended', { panelist: id, reason: e.reason })) as (e: never) => void);
  t.on('error', ((e: { code?: string; message?: string }) => rec.event('voice.error', { panelist: id, code: e.code, message: e.message })) as (e: never) => void);
  const sendText = t.sendText.bind(t);
  const sendEvent = t.sendEvent.bind(t);
  t.sendText = (text: string) => {
    rec.event('voice.sent', { panelist: id, type: 'text', text });
    sendText(text);
  };
  t.sendEvent = (marker: string) => {
    rec.event('voice.sent', { panelist: id, type: 'marker', text: marker });
    // The round's clock zero: the start marker (the greeting is asked for now).
    if (marker === '[event: start]') rec.markRoundStart();
    sendEvent(marker);
  };
}

/** The slice of the round controller the recorder listens to. */
interface ControllerLike {
  readonly state: string;
  on(event: string, cb: (v: never) => void): () => void;
}

/** Controller states, notices and errors; the round's clock zero is its first greeting. */
export function recordController(rec: RoundRecorder, c: ControllerLike): () => void {
  rec.event('ui.state', { state: c.state });
  // Attached after the round began (the page mounts late): the first time we see it running is the best zero left.
  if (c.state === 'greeting' || c.state === 'live') rec.markRoundStart();
  const offs = [
    c.on('state', ((s: string) => {
      if (s === 'greeting' || s === 'live') rec.markRoundStart();
      rec.event('ui.state', { state: s });
    }) as (v: never) => void),
    c.on('notice', ((n: unknown) => rec.event('ui.notice', { notice: redact(n) })) as (v: never) => void),
    c.on('error', ((e: { code?: string; message?: string }) => rec.event('ui.error', { code: e.code, message: e.message })) as (v: never) => void),
    c.on('transcript', ((l: { role: string; panelistId?: string; segmentId: string; text: string }) =>
      rec.event('ui.transcript', { role: l.role, panelist: l.panelistId ?? null, segment: l.segmentId, text: l.text })) as (v: never) => void),
  ];
  return () => offs.forEach((o) => o());
}

/** What the timeline says about the round itself (never a token). */
export function describeSession(res: {
  session_id: string;
  round: { id: string; mode?: string; title?: string };
  panel: { panelist_id: string; persona_id: string; display_name: string; title: string; avatar_id: string; seat: number; voice: { transport: string; fish?: { session_id?: string | null } } }[];
  panel_mode?: string;
}): Record<string, unknown> {
  return {
    session_id: res.session_id,
    round_id: res.round.id,
    round_mode: res.round.mode ?? null,
    panel_mode: res.panel_mode ?? null,
    panel: res.panel.map((p) => ({
      panelist_id: p.panelist_id,
      persona_id: p.persona_id,
      display_name: p.display_name,
      title: p.title,
      avatar_id: p.avatar_id,
      seat: p.seat,
      voice: p.voice.transport,
      fish_session_id: p.voice.transport === 'fish' ? (p.voice.fish?.session_id ?? null) : null,
    })),
  };
}
