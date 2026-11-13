// Lip sync from the interviewer's voice stream.
//
// Graph (analysis only):  MediaStreamSource ─┬─> AnalyserNode            (loudness: jaw floor, voice level)
//                                            └─> HeadAudio worklet       (Oculus viseme classifier, no outputs)
// Nothing here connects to ctx.destination. The voice is heard through the transport's own <audio> element, which
// is what Quest Browser's echo canceller uses as its reference; routing agent audio through Web Audio output would
// defeat echo cancellation, so this module never builds an audible path.
//
// Playout alignment: the classifier sees samples as they arrive and needs about 50 ms, and the mouth is drawn on the
// next frame, so without help the mouth trails the voice slightly. Lining them up is the transport's job: if voice
// playback ever goes through Web Audio, put `new DelayNode(ctx, { delayTime: 0.08 })` between that playback source
// and its output (never between the stream and this module). With the plain <audio> element, its own output
// latency already covers most of it.
//
// HeadAudio (@met4citizen/headaudio 1.0.0, MIT) gives the active viseme; we shape it ourselves (attack 40 ms,
// release 90 ms) and scale it by loudness. An RMS-driven `jawOpen` floor keeps the mouth moving with the energy of
// the voice even when the classifier lags. If the worklet or its model cannot load (offline, no AudioWorklet), we
// fall back to RMS only, with a cheap spectral split between open, rounded, spread and hissing shapes.

import workletUrl from '@met4citizen/headaudio/dist/headworklet.min.mjs?url';
import modelUrl from '@met4citizen/headaudio/dist/model-en-mixed.bin?url';
import { approach } from './rng';

/** The 15 Oculus viseme morph names, as on the avatars. */
export const VISEMES = [
  'viseme_sil',
  'viseme_PP',
  'viseme_FF',
  'viseme_TH',
  'viseme_DD',
  'viseme_kk',
  'viseme_CH',
  'viseme_SS',
  'viseme_nn',
  'viseme_RR',
  'viseme_aa',
  'viseme_E',
  'viseme_I',
  'viseme_O',
  'viseme_U',
] as const;

/** HeadAudio's viseme ids, in its own order (index = id), and its per-viseme peak values. */
const HA_ORDER = [
  'viseme_aa',
  'viseme_E',
  'viseme_I',
  'viseme_O',
  'viseme_U',
  'viseme_PP',
  'viseme_SS',
  'viseme_TH',
  'viseme_DD',
  'viseme_FF',
  'viseme_kk',
  'viseme_nn',
  'viseme_RR',
  'viseme_CH',
  'viseme_sil',
] as const;
const HA_MAX = [0.65, 0.65, 0.65, 0.65, 0.65, 0.75, 0.65, 0.65, 0.65, 0.75, 0.65, 0.65, 0.65, 0.65, 0];

export const ATTACK_S = 0.04;
export const RELEASE_S = 0.09;
const LEVEL_RELEASE_S = 0.15;
const FLOOR_DB = -52;
const TOP_DB_MIN = -32;
const TOP_DB_MAX = -14;
const PEAK_DECAY_DB_S = 4;
const SPEAKING_LEVEL = 0.15;
const SPEAKING_HANGOVER_S = 0.25;
const JAW_GAIN_VISEMES = 0.42;
const JAW_GAIN_RMS = 0.55;
const MODEL_TIMEOUT_MS = 5000;

/** The viseme classifier as LipSync sees it; HeadAudio in the app, a fake in tests. */
export interface VisemeSource {
  node: AudioNode;
  /** Active viseme id in HeadAudio order, or -1 for silence. */
  active: number;
  update(dtMs: number): void;
  /** Clears buffered audio when a new voice is wired in (optional). */
  reset?(): void;
  dispose(): void;
}

export interface LipSyncOptions {
  /** Builds the viseme classifier; defaults to HeadAudio. A rejection means RMS only. */
  createVisemeSource?: (ctx: AudioContext, speakerHz: number) => Promise<VisemeSource>;
  /** Rough speaker pitch for HeadAudio's mel spacing: about 120 (male) to 210 (female). */
  speakerHz?: number;
}

export type LipSyncEngine = 'none' | 'visemes' | 'rms';

const workletLoads = new WeakMap<BaseAudioContext, Promise<void>>();
/** HeadAudio's model record: 2 header words, a 12-float mean and a 78-float inverse covariance (bytes). */
const MODEL_RECORD_BYTES = (2 + 12 + 78) * 4;
let modelBlobUrl: Promise<string> | null = null;

/** True if the bytes can be a HeadAudio model (not the SPA's index.html answering a missing hashed asset). */
export function checkModel(bytes: ArrayBuffer, contentType: string | null): boolean {
  if (contentType?.includes('text/html')) return false;
  return bytes.byteLength > 0 && bytes.byteLength % MODEL_RECORD_BYTES === 0;
}

/** Fetches and checks the viseme model once per page; every HeadAudio node loads it from a blob URL. */
function modelOnce(): Promise<string> {
  if (!modelBlobUrl) {
    modelBlobUrl = (async () => {
      const r = await fetch(modelUrl);
      const bytes = await r.arrayBuffer();
      if (!r.ok || !checkModel(bytes, r.headers.get('content-type'))) throw new Error('viseme model missing or invalid');
      return URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    })();
    modelBlobUrl.catch(() => (modelBlobUrl = null));
  }
  return modelBlobUrl;
}

/** Fetches the viseme model ahead of the first voice, so the first word already moves the lips. Never rejects. */
export function preloadVisemeModel(): Promise<void> {
  return modelOnce().then(
    () => undefined,
    () => undefined,
  );
}

/**
 * HeadAudio on an AudioWorklet. Rejects when anything is missing, so the caller falls back to RMS.
 *
 * Its processor always asks to stay alive, so the audio thread keeps it until the AudioContext closes, even after
 * disconnect(). Build one per LipSync and keep it across voice swaps (LipSync does); never one per attach.
 */
export async function headAudioSource(ctx: AudioContext, speakerHz: number): Promise<VisemeSource> {
  if (typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet) throw new Error('no AudioWorklet');
  let load = workletLoads.get(ctx);
  if (!load) {
    load = ctx.audioWorklet.addModule(workletUrl);
    workletLoads.set(ctx, load);
    load.catch(() => workletLoads.delete(ctx));
  }
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error('viseme model timeout')), MODEL_TIMEOUT_MS),
  );
  const [, model, mod] = await Promise.race([
    Promise.all([load, modelOnce(), import('@met4citizen/headaudio/dist/headaudio.min.mjs')]),
    timeout,
  ]);
  const ha = new mod.HeadAudio(ctx, {
    parameterData: { vadGateActiveDb: -45, vadGateInactiveDb: -55, silMode: 0, speakerMeanHz: speakerHz },
  });
  try {
    await Promise.race([ha.loadModel(model), timeout]);
  } catch (e) {
    ha.disconnect();
    ha.port.close();
    throw e;
  }
  return {
    node: ha,
    get active() {
      return ha.visemeActive;
    },
    update: () => {},
    reset: () => {
      ha.visemeActive = -1;
      ha.port.postMessage({ event: 'reset' });
    },
    dispose: () => {
      ha.disconnect();
      ha.port.close();
    },
  };
}

export class LipSync {
  engine: LipSyncEngine = 'none';
  /** Smoothed loudness of the voice, 0..1 (for a speaking cue in the UI). */
  voiceLevel = 0;
  /** True while the voice is audible, with a short hangover across gaps between words. */
  isSpeaking = false;

  private readonly out: Record<string, number> = {};
  private readonly target: Record<string, number> = {};
  private src: AudioNode | null = null;
  private analyser: AnalyserNode | null = null;
  /** The viseme node in use for the current voice (null while detached or in RMS mode). */
  private visemes: VisemeSource | null = null;
  /** The one viseme node of this LipSync, built on first attach and kept across voice swaps. */
  private source: Promise<VisemeSource | null> | null = null;
  private sourceCtx: BaseAudioContext | null = null;
  private built: VisemeSource | null = null;
  private time: Float32Array<ArrayBuffer> = new Float32Array(0);
  private freq: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private binHz = 0;
  private peakDb = TOP_DB_MIN;
  private quietS = Infinity;
  private gen = 0;
  private lastNow = 0;

  constructor(private readonly opts: LipSyncOptions = {}) {
    for (const k of VISEMES) this.out[k] = this.target[k] = 0;
    this.out.jawOpen = this.target.jawOpen = 0;
  }

  /** Starts listening to `stream` (analysis only). Resolves once the engine is chosen. */
  async attach(stream: MediaStream, ctx: AudioContext): Promise<void> {
    this.detach();
    const gen = ++this.gen;
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.3;
    src.connect(an);
    this.src = src;
    this.analyser = an;
    this.time = new Float32Array(an.fftSize);
    this.freq = new Uint8Array(an.frequencyBinCount);
    this.binHz = ctx.sampleRate / an.fftSize;
    this.engine = 'rms';
    const vs = await this.visemeSource(ctx);
    if (gen !== this.gen || !vs) return;
    vs.reset?.();
    src.connect(vs.node);
    this.visemes = vs;
    this.engine = 'visemes';
  }

  /** The viseme node for ctx: built once, reused by later attaches; null means RMS only. */
  private visemeSource(ctx: AudioContext): Promise<VisemeSource | null> {
    if (this.source && this.sourceCtx === ctx) return this.source;
    this.releaseSource(); // a different context (rare): its node cannot be reused
    this.sourceCtx = ctx;
    const make = this.opts.createVisemeSource ?? headAudioSource;
    const p: Promise<VisemeSource | null> = make(ctx, this.opts.speakerHz ?? 160).then(
      (vs) => {
        if (this.source === p) this.built = vs;
        else vs.dispose(); // released while it was being built
        return vs;
      },
      (e) => {
        console.warn('lip sync: viseme model unavailable, using loudness only', e);
        if (this.source === p) this.source = null; // let a later attach try again
        return null;
      },
    );
    this.source = p;
    return p;
  }

  private releaseSource(): void {
    // A node still being built disposes itself when it resolves (source no longer matches).
    this.built?.dispose();
    this.built = null;
    this.source = null;
    this.sourceCtx = null;
  }

  /** Stops analysing the current voice. The viseme node stays for the next attach (see dispose). */
  detach(): void {
    this.gen++;
    this.src?.disconnect();
    this.analyser?.disconnect();
    this.src = this.analyser = null;
    this.visemes = null;
    this.engine = 'none';
    this.voiceLevel = 0;
    this.isSpeaking = false;
    this.quietS = Infinity;
    for (const k in this.out) this.out[k] = this.target[k] = 0;
  }

  /** Detaches and releases the viseme node (when the avatar goes away). */
  dispose(): void {
    this.detach();
    this.releaseSource();
  }

  /**
   * Advances the mouth by dtMs (default: time since the last call) and returns morph weights for the 15 visemes and
   * jawOpen. The returned object is reused between calls.
   */
  update(dtMs?: number): Record<string, number> {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = Math.min(0.1, (dtMs ?? (this.lastNow ? now - this.lastNow : 16)) / 1000);
    this.lastNow = now;
    const an = this.analyser;
    if (!an) return this.out;

    an.getFloatTimeDomainData(this.time);
    let s = 0;
    const buf = this.time;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]!;
      s += x * x;
    }
    const db = 10 * Math.log10(s / buf.length + 1e-12);
    this.peakDb = Math.max(db, this.peakDb - PEAK_DECAY_DB_S * dt);
    const top = Math.min(TOP_DB_MAX, Math.max(TOP_DB_MIN, this.peakDb));
    const raw = Math.min(1, Math.max(0, (db - FLOOR_DB) / (top - FLOOR_DB)));

    this.voiceLevel += (raw - this.voiceLevel) * approach(dt, raw > this.voiceLevel ? ATTACK_S : LEVEL_RELEASE_S);
    this.quietS = raw > SPEAKING_LEVEL ? 0 : this.quietS + dt;
    this.isSpeaking = this.quietS < SPEAKING_HANGOVER_S;

    const t = this.target;
    for (const k of VISEMES) t[k] = 0;
    if (this.visemes && this.engine === 'visemes') {
      this.visemes.update(dt * 1000);
      const id = this.visemes.active;
      if (id >= 0 && raw > 0.02) t[HA_ORDER[id]!] = HA_MAX[id]! * (0.45 + 0.55 * raw);
      t.jawOpen = raw * JAW_GAIN_VISEMES;
    } else {
      this.spectralShapes(raw);
      t.jawOpen = raw * JAW_GAIN_RMS;
    }

    const up = approach(dt, ATTACK_S);
    const down = approach(dt, RELEASE_S);
    for (const k in this.out) {
      const cur = this.out[k]!;
      const tg = t[k] ?? 0;
      this.out[k] = cur + (tg - cur) * (tg > cur ? up : down);
    }
    return this.out;
  }

  /** RMS-only mouth shapes: open by loudness, rounded or spread by where the energy sits, hiss for sibilants. */
  private spectralShapes(raw: number): void {
    const t = this.target;
    if (raw <= 0.02 || !this.analyser) return;
    this.analyser.getByteFrequencyData(this.freq);
    let sum = 0;
    let wsum = 0;
    let hi = 0;
    const f = this.freq;
    const n = f.length;
    for (let i = 1; i < n; i++) {
      const hz = i * this.binHz;
      const v = f[i]!;
      if (hz < 4000) {
        sum += v;
        wsum += v * hz;
      } else if (hz < 9000) hi += v;
    }
    const centroid = sum > 0 ? wsum / sum : 1400;
    const c = Math.min(1, Math.max(0, (centroid - 300) / 2200));
    const round = Math.max(0, 1 - c * 2);
    const spread = Math.max(0, c * 2 - 1);
    const hiss = sum + hi > 0 && hi / (sum + hi) > 0.45 ? 1 : 0;
    t.viseme_aa = raw * 0.55 * (1 - 0.6 * Math.max(round, spread)) * (1 - 0.5 * hiss);
    t.viseme_O = raw * 0.5 * round;
    t.viseme_E = raw * 0.45 * spread;
    t.viseme_SS = raw * 0.5 * hiss;
  }
}
