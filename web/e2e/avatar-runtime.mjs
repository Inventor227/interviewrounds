// Emulator run for the avatar runtime on /dev/avatar: listening face, mouth frames during the test voice, the
// thinking look, a beat, pointing, the seated view, and per-avatar update cost. Writes PNGs and stats.json.
//   plan/ops-tools/emu.sh <worktree> web/e2e/avatar-runtime.mjs --size 640x640 --out plan/shots/avatar-runtime

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { call, iwsdk, screenshot, sleep, waitReady } from './emu-lib.mjs';

const DIR = path.join(process.env.EMU_APP_DIR, '.emu');
const ID = process.env.AVATAR_ID ?? 'f01';
let n = 0;
const out = { id: ID, shots: {} };

/** Runs fn(arg) in the app page and returns its JSON result. */
async function page(fn, arg = null, timeout = 25000) {
  const file = path.join(DIR, `act-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  return await target.evaluate(${fn.toString()}, ${JSON.stringify(arg)});
}
`,
  );
  const res = await iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', String(timeout));
  const d = res && (res.data ?? res);
  return d && 'result' in d ? d.result : d;
}

async function go(p) {
  const file = path.join(DIR, `go-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  await target.goto(new URL(${JSON.stringify(p)}, target.url()).href, { waitUntil: 'load' });
  return target.url();
}
`,
  );
  return iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', '45000');
}

const status = () => page(() => ({ ...globalThis.__avatarDev?.status }));
const click = (text) => call('browser', 'interact', { steps: [{ action: 'click', locator: { text } }] });

async function shot(name) {
  await screenshot(name);
  out.shots[name] = await status().catch((e) => ({ error: String(e).slice(0, 200) }));
  console.log(name, JSON.stringify(out.shots[name]));
}

/** Waits in the page (avatar time) until cond(avatar) holds, then freezes the frame. */
async function freezeWhen(cond, maxMs = 15000) {
  return page(
    async ([src, max]) => {
      const dev = globalThis.__avatarDev;
      const test = new Function('a', `return (${src})(a)`);
      const end = performance.now() + max;
      while (performance.now() < end) {
        if (test(dev.avatar)) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      dev.freeze(true);
      const a = dev.avatar;
      return { mode: a.mode, level: a.voiceLevel, engine: a.lipSyncEngine, modeTime: a.modeTime };
    },
    [cond.toString(), maxMs],
    maxMs + 10000,
  );
}
const unfreeze = () => page(() => globalThis.__avatarDev.freeze(false));

await waitReady();
await go(`/dev/avatar?id=${ID}&view=face`);
for (let i = 0; ; i++) {
  const s = await status().catch(() => null);
  if (s && s.ready) break;
  if (s && s.error) throw new Error(`dev page failed: ${s.error}`);
  if (i > 60) throw new Error('avatar did not load');
  await sleep(2000);
}
await sleep(2000);
await shot('01-face-listening');

// Speech: the click is a user gesture, so the <audio> element and the AudioContext may start.
await click('Speak');
await sleep(1500);
out.afterSpeak = await status();
console.log('after speak', JSON.stringify(out.afterSpeak));
for (const [i, min] of [
  [1, 0.55],
  [2, 0.35],
  [3, 0.6],
]) {
  out[`freeze-${i}`] = await freezeWhen(new Function(`return (a) => a.voiceLevel > ${min}`)());
  await shot(`0${1 + i}-face-speaking-${i}`);
  await unfreeze();
  await sleep(700);
}
// A frame between words (mouth closing).
out['freeze-gap'] = await freezeWhen((a) => a.mode === 'speaking' && a.voiceLevel < 0.12);
await shot('05-face-speaking-gap');
await unfreeze();

// Thinking look: eyes up and to the side for 0.6 s after entering thinking.
await page(() => globalThis.__avatarDev.setMode('thinking'));
out['freeze-think'] = await freezeWhen((a) => a.mode === 'thinking' && a.modeTime > 0.3);
await shot('06-face-thinking-look');
await unfreeze();

// The user's seat view while speaking (beats) and listening.
await page(() => globalThis.__avatarDev.setView('seat'));
await click('Speak');
await sleep(1500);
await shot('07-seat-speaking');
await page(() => globalThis.__avatarDev.setMode('thinking'));
out['freeze-think-seat'] = await freezeWhen((a) => a.mode === 'thinking' && a.modeTime > 0.3);
await shot('08-seat-thinking-look');
await unfreeze();
await page(() => {
  globalThis.__avatarDev.pointAtBoard();
});
out['freeze-point'] = await freezeWhen((a) => a.pointW >= 1);
await shot('09-seat-pointing');
await unfreeze();
await page(() => globalThis.__avatarDev.setView('side'));
await page(() => globalThis.__avatarDev.userTalks());
await sleep(3000);
await shot('10-side-listening');

// CPU cost of Avatar.update(): 720 updates at 72 Hz steps, per mode, with the render loop frozen.
out.bench = await page(
  async () => {
    const dev = globalThis.__avatarDev;
    const a = dev.avatar;
    dev.freeze(true);
    const res = {};
    for (const mode of ['idle', 'listening', 'thinking', 'speaking']) {
      a.setMode(mode);
      for (let i = 0; i < 72; i++) a.update(1 / 72);
      const times = [];
      for (let i = 0; i < 720; i++) {
        const t0 = performance.now();
        a.update(1 / 72);
        times.push(performance.now() - t0);
      }
      times.sort((x, y) => x - y);
      const mean = times.reduce((s, x) => s + x, 0) / times.length;
      res[mode] = { meanMs: +mean.toFixed(4), p50Ms: +times[360].toFixed(4), p95Ms: +times[684].toFixed(4), maxMs: +times[719].toFixed(4) };
    }
    dev.freeze(false);
    res.engine = a.lipSyncEngine;
    res.ua = navigator.userAgent;
    res.cores = navigator.hardwareConcurrency;
    return res;
  },
  null,
  60000,
);
console.log('bench', JSON.stringify(out.bench));
const logs = await iwsdk('browser', 'logs', '--input-json', JSON.stringify({ count: 30 })).catch(() => null);
out.logs = (logs?.data?.result ?? []).map((l) => `[${l.level}] ${String(l.message).slice(0, 300)}`);
writeFileSync(path.join(process.env.EMU_SHOTS, 'stats.json'), JSON.stringify(out, null, 2));
console.log('avatar runtime ok');
