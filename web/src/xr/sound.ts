// Quiet UI sounds, synthesized (no files): a soft click for presses, a paper flap when the sheet lands, a gentle
// chime when the scorecard is ready. Hands have no haptics, so every press gets a sound; all of them stay low so
// nothing leaks into the microphone.

export interface Sounds {
  click(): void;
  flap(): void;
  chime(): void;
  setVolume(v: number): void;
}

export function createSounds(getContext: () => AudioContext | null = defaultContext): Sounds {
  let volume = 0.5;
  let noise: AudioBuffer | null = null;

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

  const run = (fn: (ctx: AudioContext) => void) => {
    const ctx = getContext();
    if (!ctx || volume <= 0) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      fn(ctx);
    } catch {
      // Sound is a nicety; never let it break input handling.
    }
  };

  return {
    click: () =>
      run((ctx) => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(1800, t);
        o.frequency.exponentialRampToValueAtTime(900, t + 0.03);
        const g = out(ctx, 0.05);
        g.gain.setValueAtTime(0.05 * volume, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        o.connect(g);
        o.start(t);
        o.stop(t + 0.06);
      }),
    flap: () =>
      run((ctx) => {
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
      }),
    chime: () =>
      run((ctx) => {
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
      }),
    setVolume: (v: number) => {
      volume = Math.max(0, Math.min(1, v));
    },
  };
}

let shared: AudioContext | null = null;
function defaultContext(): AudioContext | null {
  if (shared) return shared;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctor) return null;
  shared = new Ctor();
  return shared;
}
