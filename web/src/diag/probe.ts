// Browser probes for the device check: device and browser facts, the microphone with a live level, and audio
// autoplay. Every probe catches its own errors and reports them as values, so one failure never hides the rest.

import { getAudioContext } from '../voice/audio';
import { MIC_CONSTRAINTS } from '../voice/transport';
import { levelSummary, rms, toDb, type LevelSummary } from './stats';

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);

type Nav = Navigator & {
  xr?: XRSystem;
  deviceMemory?: number;
  userActivation?: { hasBeenActive: boolean; isActive: boolean };
  connection?: { effectiveType?: string; rtt?: number; downlink?: number };
};

export interface DeviceFacts {
  ua: string;
  quest: boolean;
  dpr: number;
  screen: string;
  viewport: string;
  cores: number | null;
  memory_gb: number | null;
  webxr: boolean;
  immersive_ar: boolean | string;
  immersive_vr: boolean | string;
  xr_hand_api: boolean;
  audio: { sample_rate: number | null; base_latency_ms: number | null; output_latency_ms: number | null; state: string | null };
  mic_constraints: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } | null;
  mic_permission: string;
  webgl: { renderer: string | null; max_texture: number | null; multiview: boolean } | null;
  webrtc: boolean;
  network: { type: string | null; rtt_ms: number | null; downlink_mbps: number | null };
}

async function supported(xr: XRSystem | undefined, mode: XRSessionMode): Promise<boolean | string> {
  if (!xr) return false;
  try {
    return await xr.isSessionSupported(mode);
  } catch (e) {
    return errText(e);
  }
}

export async function micPermission(): Promise<string> {
  try {
    const p = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    return p?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function webgl(): DeviceFacts['webgl'] {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const out = {
      renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      max_texture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      multiview: !!(gl.getExtension('OCULUS_multiview') || gl.getExtension('OVR_multiview2')),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return out;
  } catch {
    return null;
  }
}

export async function deviceFacts(): Promise<DeviceFacts> {
  const nav = navigator as Nav;
  const ctx = getAudioContext();
  const sc = navigator.mediaDevices?.getSupportedConstraints?.() as Record<string, boolean> | undefined;
  return {
    ua: nav.userAgent,
    quest: /OculusBrowser|Quest/i.test(nav.userAgent),
    dpr: window.devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    cores: nav.hardwareConcurrency ?? null,
    memory_gb: nav.deviceMemory ?? null,
    webxr: !!nav.xr,
    immersive_ar: await supported(nav.xr, 'immersive-ar'),
    immersive_vr: await supported(nav.xr, 'immersive-vr'),
    xr_hand_api: typeof (globalThis as { XRHand?: unknown }).XRHand !== 'undefined',
    audio: {
      sample_rate: ctx?.sampleRate ?? null,
      base_latency_ms: ctx?.baseLatency != null ? Math.round(ctx.baseLatency * 1000) : null,
      output_latency_ms: ctx && 'outputLatency' in ctx ? Math.round((ctx.outputLatency ?? 0) * 1000) : null,
      state: ctx?.state ?? null,
    },
    mic_constraints: sc ? { echoCancellation: !!sc.echoCancellation, noiseSuppression: !!sc.noiseSuppression, autoGainControl: !!sc.autoGainControl } : null,
    mic_permission: await micPermission(),
    webgl: webgl(),
    webrtc: typeof RTCPeerConnection !== 'undefined',
    network: { type: nav.connection?.effectiveType ?? null, rtt_ms: nav.connection?.rtt ?? null, downlink_mbps: nav.connection?.downlink ?? null },
  };
}

// ---- level meter ----

/** Samples a stream's level about 20 times a second. */
export class LevelMeter {
  private readonly analyser: AnalyserNode;
  private readonly src: MediaStreamAudioSourceNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: AudioContext, stream: MediaStream, onLevel: (db: number, t: number) => void, everyMs = 50) {
    this.src = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    // Analysis only: nothing goes to the speakers.
    this.src.connect(this.analyser);
    this.timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buf);
      onLevel(toDb(rms(this.buf)), performance.now());
    }, everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.src.disconnect();
  }
}

// ---- microphone ----

export interface MicResult {
  permission_before: string;
  permission_after: string | null;
  grant_ms: number | null;
  error: string | null;
  label: string | null;
  settings: Record<string, unknown> | null;
  /** Levels while the test ran (dBFS): the quiet part is the room, the loud part is the tester's voice. */
  level: LevelSummary | null;
}

export class MicTest {
  result: MicResult = { permission_before: 'unknown', permission_after: null, grant_ms: null, error: null, label: null, settings: null, level: null };
  private stream: MediaStream | null = null;
  private meter: LevelMeter | null = null;
  private readonly levels: number[] = [];

  constructor(private readonly onLevel: (db: number) => void) {}

  get running(): boolean {
    return !!this.stream;
  }

  async start(): Promise<MicResult> {
    this.result.permission_before = await micPermission();
    const t0 = performance.now();
    try {
      const ctx = getAudioContext();
      // Resume in the tap, before the permission prompt takes the user activation.
      const resumed = ctx?.resume().catch(() => undefined);
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
      this.result.grant_ms = Math.round(performance.now() - t0);
      await resumed;
      const track = this.stream.getAudioTracks()[0];
      this.result.label = track?.label ? 'present' : null;
      const s = (track?.getSettings() ?? {}) as Record<string, unknown>;
      const keep = ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'sampleRate', 'channelCount', 'latency', 'voiceIsolation'];
      this.result.settings = Object.fromEntries(keep.filter((k) => k in s).map((k) => [k, s[k]]));
      if (ctx) {
        this.meter = new LevelMeter(ctx, this.stream, (db) => {
          if (this.levels.length < 2400) this.levels.push(db);
          this.onLevel(db);
        });
      }
    } catch (e) {
      this.result.error = errText(e);
    }
    this.result.permission_after = await micPermission();
    return this.result;
  }

  stop(): MicResult {
    this.meter?.stop();
    this.meter = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.result.level = levelSummary(this.levels);
    return this.result;
  }
}

// ---- autoplay ----

/** A short tone as a WAV blob URL (played through an <audio> element, as the voice is). */
export function toneUrl(freq = 660, ms = 350, rate = 22050): string {
  const n = Math.round((rate * ms) / 1000);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400);
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.25 * fade * 32767), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export interface PlayResult {
  /** The page had a tap or key press before (the browser then allows autoplay). */
  had_activation: boolean | null;
  media: 'played' | 'blocked' | string;
  context_state: string | null;
}

/** Plays the tone through a media element and reports whether the browser let it. */
export async function playTone(url: string): Promise<PlayResult> {
  const nav = navigator as Nav;
  const had = nav.userActivation ? nav.userActivation.hasBeenActive : null;
  const ctx = getAudioContext();
  let state: string | null = ctx?.state ?? null;
  try {
    // Without a tap resume() can stay pending: wait a moment, then read the state.
    if (ctx) await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    state = ctx?.state ?? null;
  } catch {
    // keeps the state before
  }
  const el = new Audio(url);
  el.volume = 0.6;
  try {
    await el.play();
    return { had_activation: had, media: 'played', context_state: state };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { had_activation: had, media: name === 'NotAllowedError' ? 'blocked' : errText(e), context_state: state };
  }
}
