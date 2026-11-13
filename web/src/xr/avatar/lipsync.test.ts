import { describe, expect, it } from 'vitest';
import { LipSync, VISEMES, type VisemeSource } from './lipsync';

// A fake AudioContext: records the graph so the test can prove nothing reaches the speakers, and feeds the
// analyser from a signal function of time.
class FakeNode {
  readonly outs: unknown[] = [];
  constructor(readonly kind: string) {}
  connect(n: unknown) {
    this.outs.push(n);
    return n;
  }
  disconnect() {
    this.outs.length = 0;
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  constructor(private readonly ctx: FakeCtx) {
    super('analyser');
  }
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getFloatTimeDomainData(buf: Float32Array) {
    const sr = this.ctx.sampleRate;
    const t0 = this.ctx.currentTime - buf.length / sr;
    for (let i = 0; i < buf.length; i++) buf[i] = this.ctx.signal(t0 + i / sr);
  }
  getByteFrequencyData(buf: Uint8Array) {
    buf.fill(0);
  }
}

class FakeCtx {
  sampleRate = 48000;
  currentTime = 1;
  signal: (t: number) => number = () => 0;
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  audioWorklet = { addModule: () => Promise.reject(new Error('offline')) };
  createMediaStreamSource() {
    const n = new FakeNode('source');
    this.nodes.push(n);
    return n;
  }
  createAnalyser() {
    const n = new FakeAnalyser(this);
    this.nodes.push(n);
    return n;
  }
  createGain() {
    const n = new FakeNode('gain');
    this.nodes.push(n);
    return n;
  }
}

const stream = {} as MediaStream;
const ctxOf = (c: FakeCtx) => c as unknown as AudioContext;

function run(ls: LipSync, ctx: FakeCtx, seconds: number, dtMs = 1000 / 72) {
  let out: Record<string, number> = {};
  for (let t = 0; t < seconds * 1000; t += dtMs) {
    ctx.currentTime += dtMs / 1000;
    out = ls.update(dtMs);
  }
  return out;
}

const sine = (hz: number, dbfs: number) => {
  const a = Math.pow(10, dbfs / 20);
  return (t: number) => a * Math.sin(2 * Math.PI * hz * t);
};

describe('lipsync', () => {
  it('lipsync_silence_closes_mouth', async () => {
    const ctx = new FakeCtx();
    const ls = new LipSync();
    await ls.attach(stream, ctxOf(ctx));
    // Some speech first, then silence: everything must settle closed.
    ctx.signal = sine(220, -12);
    run(ls, ctx, 0.5);
    ctx.signal = () => 0;
    const out = run(ls, ctx, 1);
    for (const v of VISEMES) expect(out[v] ?? 0).toBeLessThan(0.05);
    expect(out.jawOpen ?? 0).toBeLessThan(0.05);
    expect(ls.voiceLevel).toBeLessThan(0.05);
    expect(ls.isSpeaking).toBe(false);
  });

  it('lipsync_loud_opens_jaw', async () => {
    const ctx = new FakeCtx();
    const ls = new LipSync();
    await ls.attach(stream, ctxOf(ctx));
    ctx.signal = sine(220, -12);
    const out = run(ls, ctx, 0.3);
    expect(out.jawOpen).toBeGreaterThan(0.3);
    expect(ls.isSpeaking).toBe(true);
    expect(ls.voiceLevel).toBeGreaterThan(0.5);
  });

  it('lipsync_falls_back_to_rms_when_the_model_cannot_load', async () => {
    const ctx = new FakeCtx();
    const ls = new LipSync();
    await ls.attach(stream, ctxOf(ctx));
    expect(ls.engine).toBe('rms');
  });

  it('lipsync_never_routes_audio_to_the_speakers', async () => {
    const ctx = new FakeCtx();
    const visemes: VisemeSource = { node: new FakeNode('worklet') as unknown as AudioNode, active: -1, update() {}, dispose() {} };
    const ls = new LipSync({ createVisemeSource: async () => visemes });
    await ls.attach(stream, ctxOf(ctx));
    expect(ls.engine).toBe('visemes');
    // Every node the lip sync built: none of them connects to the destination.
    const reach = new Set<unknown>();
    const walk = (n: unknown) => {
      if (reach.has(n)) return;
      reach.add(n);
      for (const o of (n as FakeNode).outs ?? []) walk(o);
    };
    for (const n of ctx.nodes) walk(n);
    expect(reach.has(ctx.destination)).toBe(false);
    // The source feeds the analyser and the viseme worklet.
    const src = ctx.nodes.find((n) => n.kind === 'source')!;
    expect(src.outs).toContain(visemes.node);
    expect(src.outs.some((n) => (n as FakeNode).kind === 'analyser')).toBe(true);
  });

  it('lipsync_visemes_attack_fast_release_slower', async () => {
    const ctx = new FakeCtx();
    const vs: VisemeSource = { node: new FakeNode('worklet') as unknown as AudioNode, active: -1, update() {}, dispose() {} };
    const ls = new LipSync({ createVisemeSource: async () => vs });
    await ls.attach(stream, ctxOf(ctx));
    ctx.signal = sine(180, -18);
    run(ls, ctx, 0.3);
    vs.active = 0; // viseme_aa
    const a40 = run(ls, ctx, 0.04, 4).viseme_aa ?? 0;
    const full = run(ls, ctx, 0.3, 4).viseme_aa ?? 0;
    expect(full).toBeGreaterThan(0.4);
    // About 63 % of the way after one attack time constant (40 ms).
    expect(a40 / full).toBeGreaterThan(0.5);
    expect(a40 / full).toBeLessThan(0.75);
    vs.active = -1;
    const r40 = run(ls, ctx, 0.04, 4).viseme_aa ?? 0;
    // Release is slower: after 40 ms most of it is still there (90 ms constant).
    expect(r40 / full).toBeGreaterThan(0.55);
    const r400 = run(ls, ctx, 0.4, 4).viseme_aa ?? 0;
    expect(r400).toBeLessThan(0.05);
  });

  it('lipsync_detach_disconnects', async () => {
    const ctx = new FakeCtx();
    const ls = new LipSync();
    await ls.attach(stream, ctxOf(ctx));
    ls.detach();
    for (const n of ctx.nodes) expect(n.outs.length).toBe(0);
    expect(ls.engine).toBe('none');
    const out = ls.update(16);
    expect(out.jawOpen ?? 0).toBe(0);
  });
});
