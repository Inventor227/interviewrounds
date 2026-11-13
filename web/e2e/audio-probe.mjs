// How fast WebAudio runs in the emulator's browser: plays a 20 s line of synthetic speech into a
// MediaStreamDestination (as fish-round.mjs feeds the microphone) and compares its length with the wall time it took,
// on a page without WebGL and on the 2D preview of the room, at two viewport sizes and two latency hints.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/audio-probe.mjs --size 1280x720 --out plan/shots/t22/audio-probe
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.EMU_APP_DIR;
copyFileSync(path.join(APP, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { go, page, play, sleep } = L;
const voiceDir = path.join(APP, 'public', '__emu_voice');
mkdirSync(voiceDir, { recursive: true });
for (const f of readdirSync(path.join(APP, 'e2e', 'voice'))) copyFileSync(path.join(APP, 'e2e', 'voice', f), path.join(voiceDir, f));

const probe = (hint) =>
  page(
    async (h) => {
      const ctx = new AudioContext(h ? { latencyHint: h, sampleRate: 48000 } : { sampleRate: 48000 });
      await ctx.resume().catch(() => undefined);
      const dest = ctx.createMediaStreamDestination();
      const buf = await ctx.decodeAudioData(await (await fetch('/__emu_voice/d1.wav')).arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      const t0 = performance.now();
      const c0 = ctx.currentTime;
      const done = new Promise((r) => (src.onended = r));
      src.start();
      await done;
      const wall = (performance.now() - t0) / 1000;
      const out = { hint: h ?? 'default', state: ctx.state, base_latency: ctx.baseLatency, seconds: Math.round(buf.duration * 10) / 10, wall_s: Math.round(wall * 10) / 10, rate: Math.round((buf.duration / wall) * 100) / 100, ctx_rate: Math.round(((ctx.currentTime - c0) / wall) * 100) / 100 };
      await ctx.close();
      return out;
    },
    hint,
    90_000,
  );

const out = [];
await waitReady();
for (const [where, url] of [
  ['page without WebGL', '/settings'],
  ['2D preview of the room', '/session/emu?view=preview&seats=1'],
]) {
  await go(url);
  await sleep(6000);
  for (const size of [[1280, 720], [512, 512]]) {
    await play(`await page.setViewportSize({ width: ${size[0]}, height: ${size[1]} }); return true;`).catch(() => undefined);
    await sleep(2000);
    for (const hint of [null, 'playback']) {
      const r = await probe(hint).catch((e) => ({ error: String(e).slice(0, 200) }));
      const row = { where, size: size.join('x'), ...r };
      out.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
writeFileSync(path.join(process.env.EMU_SHOTS, 'audio-probe.json'), JSON.stringify(out, null, 2));
console.log('audio probe ok');
