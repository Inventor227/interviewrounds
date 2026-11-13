import { describe, expect, it } from 'vitest';
import { createSounds, SOUND_NAMES, type SoundName } from './sound';

// A recording stand-in for the few Web Audio calls the sounds make.
function fakeContext() {
  const gains: { gain: { value: number; setValueAtTime(v: number): void } }[] = [];
  const sources: { buffer: unknown; started: boolean }[] = [];
  let oscillators = 0;
  const param = () => ({
    value: 0,
    setValueAtTime(v: number) {
      this.value = v;
    },
    exponentialRampToValueAtTime() {},
  });
  const node = () => ({ connect: (n: unknown) => n });
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    resume: async () => {},
    createGain() {
      const g = { ...node(), gain: param() };
      gains.push(g);
      return g;
    },
    createBufferSource() {
      const s = { ...node(), buffer: null as unknown, started: false, start() { s.started = true; }, stop() {} };
      sources.push(s);
      return s;
    },
    createOscillator() {
      oscillators++;
      return { ...node(), type: 'sine', frequency: param(), start() {}, stop() {} };
    },
    createBiquadFilter: () => ({ ...node(), type: 'lowpass', frequency: param(), Q: param() }),
    createBuffer: (_c: number, len: number) => ({ sampleRate: 48000, getChannelData: () => new Float32Array(len) }),
    decodeAudioData: async () => ({ fake: 'live' }),
  };
  return { ctx: ctx as unknown as AudioContext, gains, sources, oscillators: () => oscillators };
}

const fakeBuffer = (name: string) => ({ name }) as unknown as AudioBuffer;

function sampled(missing: SoundName[] = []) {
  const f = fakeContext();
  const urls: string[] = [];
  const decoded: string[] = [];
  const s = createSounds(() => f.ctx, {
    baseUrl: '/sfx/',
    load: async (url) => {
      urls.push(url);
      if (missing.some((m) => url.endsWith(`/${m}.ogg`))) throw new Error('404');
      return new TextEncoder().encode(url).buffer as ArrayBuffer;
    },
    decode: (bytes) => {
      const url = new TextDecoder().decode(bytes);
      decoded.push(url);
      return Promise.resolve(fakeBuffer(url));
    },
  });
  return { s, f, urls, decoded };
}

describe('createSounds', () => {
  it('plays_every_board_and_ui_sound_by_name_without_audio', () => {
    // No AudioContext (tests, muted pages): every sound is a quiet no-op, never an error.
    const s = createSounds(() => null, { load: () => Promise.reject(new Error('offline')) });
    for (const n of SOUND_NAMES) expect(() => s.play(n)).not.toThrow();
  });

  it('preload_fetches_and_decodes_all_six_samples_once', async () => {
    const { s, f, urls, decoded } = sampled();
    await Promise.all([s.preload(), s.preload()]);
    await s.preload();
    expect(urls.sort()).toEqual(SOUND_NAMES.map((n) => `/sfx/${n}.ogg`).sort());
    expect(decoded).toHaveLength(6);
    for (const n of SOUND_NAMES) s.play(n);
    expect(f.sources.map((x) => (x.buffer as { name: string }).name)).toEqual(SOUND_NAMES.map((n) => `/sfx/${n}.ogg`));
    expect(f.sources.every((x) => x.started)).toBe(true);
    expect(f.oscillators()).toBe(0);
  });

  it('preload_is_safe_before_any_audio_context_exists', async () => {
    let asked = 0;
    const s = createSounds(
      () => {
        asked++;
        return null;
      },
      { load: async () => new ArrayBuffer(4), decode: () => null },
    );
    await expect(s.preload()).resolves.toBeUndefined();
    expect(asked).toBe(0);
  });

  it('falls_back_to_the_synthesized_sound_when_a_sample_is_missing', async () => {
    const { s, f } = sampled(['chime']);
    await s.preload();
    s.chime();
    expect(f.oscillators()).toBe(2); // the two-note synth chime
    expect(f.sources).toHaveLength(0);
    s.click();
    expect(f.sources).toHaveLength(1); // the others still use their samples
  });

  it('applies_the_settings_volume_to_samples', async () => {
    const { s, f } = sampled();
    await s.preload();
    s.setVolume(0.2);
    s.click();
    expect(f.gains.at(-1)!.gain.value).toBeCloseTo(0.2);
    s.setVolume(3);
    s.snap();
    expect(f.gains.at(-1)!.gain.value).toBeCloseTo(1);
    s.setVolume(0);
    s.pen();
    expect(f.sources).toHaveLength(2);
  });

  it('stays_silent_while_the_user_is_speaking', async () => {
    let speaking = true;
    const f = fakeContext();
    const s = createSounds(() => f.ctx, {
      isSpeaking: () => speaking,
      load: async () => new ArrayBuffer(4),
      decode: () => Promise.resolve(fakeBuffer('x')),
    });
    await s.preload();
    s.click();
    expect(f.sources).toHaveLength(0);
    speaking = false;
    s.click();
    expect(f.sources).toHaveLength(1);
  });

  it('decodes_on_the_live_context_when_no_offline_decoder_exists', async () => {
    const f = fakeContext();
    const s = createSounds(() => f.ctx, { load: async () => new ArrayBuffer(4), decode: () => null });
    await s.preload();
    s.click(); // still synthesized; decoding starts now
    expect(f.oscillators()).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    s.click();
    expect(f.sources.at(-1)!.buffer).toEqual({ fake: 'live' });
  });
});
