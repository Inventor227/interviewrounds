// Quiet UI sounds: small recorded samples (public/sfx, credits in CREDITS.md) for presses, the sheet landing, the
// scorecard, cards, strokes and the bin. Hands have no haptics, so every press gets a sound; every sample is
// normalised low (peak -24 dBFS, the chime -20) so nothing leaks into the microphone. If a sample has not loaded
// (yet, or ever), the same sound is synthesized instead, so a press is never silent.

export type SoundName = 'click' | 'flap' | 'chime' | 'snap' | 'pen' | 'erase';

export const SOUND_NAMES: readonly SoundName[] = ['click', 'flap', 'chime', 'snap', 'pen', 'erase'];

export interface Sounds {
  click(): void;
  flap(): void;
  chime(): void;
  /** A card snaps into place on the sheet. */
  snap(): void;
  /** A stroke starts. */
  pen(): void;
  /** Something goes in the bin. */
  erase(): void;
  /** By name (the board's sfx port). */
  play(name: SoundName): void;
  setVolume(v: number): void;
}

export interface SampledSounds extends Sounds {
  /**
   * Fetches and decodes every sample once. Safe to call before any AudioContext exists (it never creates one) and
   * any number of times; it never rejects. A sample that fails to load stays synthesized.
   */
  preload(): Promise<void>;
}

export interface SoundOptions {
  /** Where the samples live (default: the app base + `sfx/`). */
  baseUrl?: string;
  /** Fetches one sample's bytes. */
  load?: (url: string) => Promise<ArrayBuffer>;
  /** Decodes bytes without a live context; return null when that is not possible here. */
  decode?: (bytes: ArrayBuffer) => Promise<AudioBuffer> | null;
  /** True while the user is speaking: sounds are skipped so they never reach the microphone. */
  isSpeaking?: () => boolean;
}

export function createSounds(
  getContext: () => AudioContext | null = defaultContext,
  opts: SoundOptions = {},
): SampledSounds {
  let volume = 0.5;
  let noise: AudioBuffer | null = null;
  const baseUrl = opts.baseUrl ?? defaultBaseUrl();
  const load = opts.load ?? defaultLoad;
  const decode = opts.decode ?? offlineDecode;
  const buffers = new Map<SoundName, AudioBuffer>();
  // Bytes fetched before any decoder was available; decoded on the first sound with a live context.
  const pending = new Map<SoundName, ArrayBuffer>();
  let preloading: Promise<void> | null = null;

  const out = (ctx: AudioContext, level: number): GainNode => {
    const g = ctx.createGain();
    g.gain.value = level * volume;
    g.connect(ctx.destination);
    return g;
  };

  const noiseBuffer = (ctx: AudioContext): AudioBuffer => {
    if (noise && noise.sampleRate === ctx.sampleRate) return noise;
    const len = Math.floor(ctx.sampleRate * 0.25);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < len; i++) {
      seed = (seed * 16807) % 2147483647;
      d[i] = (seed / 2147483647) * 2 - 1;
    }
    return noise;
  };

  const decodePending = (ctx: AudioContext) => {
    for (const [name, bytes] of pending) {
      pending.delete(name);
      ctx.decodeAudioData(bytes).then(
        (b) => void buffers.set(name, b),
        () => {}, // stays synthesized
      );
    }
  };

  const run = (fn: (ctx: AudioContext) => void) => {
    if (volume <= 0 || opts.isSpeaking?.()) return;
    const ctx = getContext();
    if (!ctx) return;
    void preload(); // in case the app did not ask earlier; this sound may still be synthesized
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      if (pending.size) decodePending(ctx);
      fn(ctx);
    } catch {
      // Sound is a nicety; never let it break input handling.
    }
  };

  const sample = (ctx: AudioContext, buf: AudioBuffer) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(out(ctx, 1));
    src.start();
  };

  // ---- synthesized fallbacks ----
  const tone = (ctx: AudioContext, type: OscillatorType, from: number, to: number, ms: number, level: number) => {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    const g = out(ctx, level);
    g.gain.setValueAtTime(level * volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g);
    o.start(t);
    o.stop(t + ms / 1000 + 0.01);
  };
  const noiseBurst = (ctx: AudioContext, type: BiquadFilterType, hz: number, ms: number, level: number) => {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    const g = out(ctx, level);
    g.gain.setValueAtTime(level * volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    src.connect(f).connect(g);
    src.start(t);
    src.stop(t + ms / 1000 + 0.01);
  };
  const synth: Record<SoundName, (ctx: AudioContext) => void> = {
    snap: (ctx) => tone(ctx, 'square', 520, 260, 45, 0.03),
    pen: (ctx) => noiseBurst(ctx, 'highpass', 3500, 60, 0.025),
    erase: (ctx) => noiseBurst(ctx, 'lowpass', 700, 140, 0.05),
    click: (ctx) => tone(ctx, 'triangle', 1800, 900, 50, 0.05),
    flap: (ctx) => {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(900, t);
      f.frequency.exponentialRampToValueAtTime(350, t + 0.18);
      f.Q.value = 0.8;
      const g = out(ctx, 0.06);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06 * volume, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      src.connect(f).connect(g);
      src.start(t);
      src.stop(t + 0.22);
    },
    chime: (ctx) => {
      const t = ctx.currentTime;
      [660, 990].forEach((hz, i) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz;
        const g = out(ctx, 0.035);
        const s = t + i * 0.12;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.035 * volume, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.6);
        o.connect(g);
        o.start(s);
        o.stop(s + 0.65);
      });
    },
  };

  const play = (name: SoundName) =>
    run((ctx) => {
      const buf = buffers.get(name);
      if (buf) sample(ctx, buf);
      else synth[name](ctx);
    });

  const fetchOne = async (name: SoundName) => {
    try {
      const bytes = await load(`${baseUrl}${name}.ogg`);
      const decoding = decode(bytes);
      if (decoding) buffers.set(name, await decoding);
      else pending.set(name, bytes);
    } catch {
      // Missing or undecodable: this sound stays synthesized.
    }
  };

  const preload = () => (preloading ??= Promise.all(SOUND_NAMES.map(fetchOne)).then(() => undefined));

  return {
    click: () => play('click'),
    flap: () => play('flap'),
    chime: () => play('chime'),
    snap: () => play('snap'),
    pen: () => play('pen'),
    erase: () => play('erase'),
    play,
    setVolume: (v: number) => {
      volume = Math.max(0, Math.min(1, v));
    },
    preload,
  };
}

function defaultBaseUrl(): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}sfx/`;
}

async function defaultLoad(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sfx ${res.status}`);
  return res.arrayBuffer();
}

// An OfflineAudioContext decodes without audio output or a user gesture; its buffers play in any context.
function offlineDecode(bytes: ArrayBuffer): Promise<AudioBuffer> | null {
  const Ctor = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctor) return null;
  return new Ctor(1, 1, 48000).decodeAudioData(bytes);
}

let shared: AudioContext | null = null;
function defaultContext(): AudioContext | null {
  if (shared) return shared;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return null;
  shared = new Ctor();
  return shared;
}
