// Shared helpers for the end-to-end round runs in the emulator (round-*.mjs). They drive the real app against the
// deployed server with the typed-turn fake voice: the dev key comes from the environment and is put into the tab's
// storage, never printed.

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { call, enterXR, iwsdk, screenshot, sleep } from './emu-lib.mjs';

export const DIR = path.join(process.env.EMU_APP_DIR, '.emu');
export const SHOTS = process.env.EMU_SHOTS ?? '.';
let n = 0;

/** Runs fn(arg) in the app page (or its runtime frame) and returns the value. */
export async function page(fn, arg = null, timeout = 25000) {
  const file = path.join(DIR, `rd-${++n}.mjs`);
  writeFileSync(
    file,
    `export default async function ({ page, frame }) {
  const target = frame ?? page.mainFrame();
  return await target.evaluate(${fn.toString()}, ${JSON.stringify(arg)});
}
`,
  );
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', String(timeout));
      const d = out && (out.data ?? out);
      return d && 'result' in d ? d.result : d;
    } catch (e) {
      if (attempt >= 3 || !/different document|Execution context was destroyed|frame was detached|navigation/i.test(e.message)) throw e;
      await sleep(2000);
    }
  }
}

/** Runs Playwright code (a function body with `page` and `frame` in scope) in the managed browser. */
export async function play(body, timeout = 30000) {
  const file = path.join(DIR, `rd-pw-${++n}.mjs`);
  writeFileSync(file, `export default async function ({ page, frame: f }) {\n  const frame = f ?? page.mainFrame();\n${body}\n}\n`);
  const out = await iwsdk('browser', 'run', path.relative(process.env.EMU_APP_DIR, file), '--timeout', String(timeout));
  const d = out && (out.data ?? out);
  return d && 'result' in d ? d.result : d;
}

export async function go(p) {
  return play(`await frame.goto(new URL(${JSON.stringify(p)}, frame.url()).href, { waitUntil: 'load' }); return frame.url();`, 45000);
}

const BIN = path.join(process.env.EMU_APP_DIR, 'node_modules/.bin/iwsdk');

/** xr <action> with the real error text. */
export function xr(action, input) {
  return new Promise((resolve, reject) => {
    execFile(BIN, ['xr', action, '--input-json', JSON.stringify(input)], { cwd: process.env.EMU_APP_DIR, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      let out = stdout;
      try {
        out = JSON.parse(stdout);
      } catch {}
      if (err) return reject(new Error(`xr ${action} failed (exit ${err.code}): ${String(stderr || stdout).slice(-3000)}`));
      resolve(out);
    });
  });
}

export const stages = [];
const t0 = Date.now();
/** Records a stage of the run (name, seconds since the script started, detail) and prints it. */
export function stage(name, detail = null) {
  const s = { name, at_s: Math.round((Date.now() - t0) / 100) / 10, detail };
  stages.push(s);
  console.log(`[stage] ${name} @${s.at_s}s ${detail ? JSON.stringify(detail).slice(0, 600) : ''}`);
}

export async function consoleLines(count = 200) {
  const out = await iwsdk('browser', 'logs', '--input-json', JSON.stringify({ count })).catch(() => null);
  const list = out?.data?.result ?? out?.result ?? out?.data?.logs ?? [];
  return Array.isArray(list) ? list.map((l) => `[${l.level}] ${String(l.message ?? l.text ?? '').slice(0, 400)}`) : [JSON.stringify(out).slice(0, 2000)];
}

export async function fail(msg, extra) {
  console.error(`FAILED: ${msg}`, extra ? JSON.stringify(extra).slice(0, 3000) : '');
  const logs = await consoleLines().catch(() => []);
  const where = await page(() => ({ path: location.pathname, text: document.querySelector('main')?.innerText.slice(0, 800), launch: document.querySelector('[data-launch]')?.getAttribute('data-launch'), rec: globalThis.__rec ?? null })).catch((e) => String(e).slice(0, 300));
  console.error('page', JSON.stringify(where).slice(0, 3000));
  console.error('console', logs.filter((l) => !/▀|▄|██/.test(l)).slice(-60).join('\n'));
  save('failed', { error: msg, extra, where, logs });
  await screenshot('failed').catch(() => undefined);
  process.exit(1);
}

export function save(name, data) {
  writeFileSync(path.join(SHOTS, `${name}.json`), JSON.stringify({ ...data, stages }, null, 2));
}

/** Polls fn in the page until it returns something truthy. */
export async function until(what, fn, arg = null, timeoutMs = 60000, everyMs = 1500) {
  const end = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await page(fn, arg).catch((e) => ({ __error: String(e).slice(0, 300) }));
    if (last && !last.__error) return last;
    if (Date.now() > end) await fail(`timed out waiting for ${what}`, last);
    await sleep(everyMs);
  }
}

/**
 * Before the first tap: the dev key and tooling flags in the tab's storage, a silent microphone, and no speech
 * engine (the fake voice then paces its lines with a timer, which headless browsers handle). The key is read from
 * the environment by the code that runs in the managed browser's driver: it is never written into a script file.
 */
export async function setupTab({ offer = true, fallback = 180, ghostSettle = 0 } = {}) {
  if (!process.env.DEV_KEY) await fail('DEV_KEY is not set (pass --env-file)');
  const ok = await play(`
    const key = process.env.DEV_KEY;
    if (!key) return 'no key in the driver process';
    return await frame.evaluate((a) => {
      sessionStorage.setItem('ir_dev_key', a.key);
      if (a.offer) sessionStorage.setItem('ir_offer', '1');
      sessionStorage.setItem('ir_fallback', String(a.fallback));
      if (a.ghostSettle) sessionStorage.setItem('ir_ghost_settle', String(a.ghostSettle));
      const ctx = new AudioContext();
      navigator.mediaDevices.getUserMedia = async () => ctx.createMediaStreamDestination().stream;
      Object.defineProperty(globalThis, 'speechSynthesis', { value: undefined, configurable: true });
      return true;
    }, { key, offer: ${JSON.stringify(offer)}, fallback: ${JSON.stringify(fallback)}, ghostSettle: ${JSON.stringify(ghostSettle)} });`);
  if (ok !== true) await fail('could not set up the tab', ok);
}

/** Records the round's transcript, states and errors in the page (call once the session page is up). */
export async function recordRound() {
  await until('the round on the session page', () => {
    const r = globalThis.__round;
    if (!r) return null;
    if (!globalThis.__rec) {
      const rec = (globalThis.__rec = { lines: [], states: [r.controller.state], errors: [], sent: [] });
      r.controller.on('state', (s) => rec.states.push(s));
      r.controller.on('error', (e) => rec.errors.push(`${e.code}: ${e.message}`));
      r.controller.on('transcript', (l) => {
        const i = rec.lines.findIndex((x) => x.segmentId === l.segmentId && x.role === l.role);
        const line = { role: l.role, who: l.panelistId, segmentId: l.segmentId, text: l.text, at: Date.now() };
        if (i >= 0) rec.lines[i] = line;
        else rec.lines.push(line);
      });
    }
    return true;
  });
}

export const roundState = () =>
  page(() => {
    const r = globalThis.__round;
    const rec = globalThis.__rec;
    return r ? { state: r.controller.state, floor: r.controller.floor, states: rec?.states, errors: rec?.errors, lines: rec?.lines.length } : null;
  });

export const waitState = (want, timeoutMs = 90000) =>
  until(`state ${want}`, (w) => (w.includes(globalThis.__round?.controller.state) ? { state: globalThis.__round.controller.state } : null), [].concat(want), timeoutMs);

/** Sends a typed answer and waits until the interviewer has answered and gone quiet. */
export async function answer(text, timeoutMs = 90000) {
  const before = await page(() => globalThis.__rec.lines.filter((l) => l.role === 'agent').length);
  await page((t) => globalThis.__round.controller.sendTypedTurn(t), text);
  const end = Date.now() + timeoutMs;
  let reply = null;
  for (;;) {
    await sleep(2500);
    reply = await page((b) => {
      const agent = globalThis.__rec.lines.filter((l) => l.role === 'agent');
      const last = agent.at(-1);
      // Quiet: a new line came and has not grown for 4 s.
      return agent.length > b && last && Date.now() - last.at > 4000 ? { who: last.who, text: last.text } : null;
    }, before);
    if (reply) return reply;
    // The round can end by itself while we wait (a time limit in the slow emulator): that is not a failure here.
    const st = await roundState();
    if (st && !['live', 'greeting', 'paused'].includes(st.state)) return { ended: true, state: st.state };
    if (Date.now() > end) await fail('no reply to a typed answer', st);
  }
}

/** Clicks an element of the page by its data-test hook (a real pointer click). */
export const click = (test, timeout = 20000) => play(`await frame.click('[data-test="${test}"]', { timeout: ${timeout} }); return true;`, timeout + 8000);

export async function shot(name) {
  await screenshot(name);
  stage(`shot ${name}`, await page(() => globalThis.__xrApp?.stats?.() ?? null).catch(() => null));
}

/** Starts the XR session from the Enter tap; falls back to accepting the offered session (emulator tooling). */
export async function enterFromTap(test = 'start-round') {
  await click(test);
  await sleep(3000);
  let inXr = await page(() => !!globalThis.__xrApp?.world.session).catch(() => false);
  if (!inXr) {
    stage('enter tap did not start the session; accepting the offered one', await page(() => ({ path: location.pathname, app: !!globalThis.__xrApp, round: !!globalThis.__round, text: document.querySelector('main')?.innerText.slice(0, 300) })).catch((e) => String(e).slice(0, 200)));
    await enterXR();
    await sleep(1500);
    // The controller reported the failed enter: the page offers Enter again.
    const again = await page(() => !!document.querySelector('[data-test="enter-room"]')).catch(() => false);
    if (again) await click('enter-room');
    inXr = await page(() => !!globalThis.__xrApp?.world.session).catch(() => false);
  }
  if (!inXr) await fail('no XR session');
  return inXr;
}

/** Sits the user at the desk, rests the right index tip on it and waits for the placement. */
export async function placeDesk(S, shotName = '03-placing', { onboarding = 'skip' } = {}) {
  await call('xr', 'set-input-mode', { mode: 'hand' });
  await call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -38, yaw: 0, roll: 0 } });
  await call('xr', 'set-transform', { device: 'hand-left', position: { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, orientation: 'auto' });
  await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.3, y: 0.95, z: S.head.z - 0.1 }, orientation: 'auto' });
  await sleep(1500);
  await shot(shotName);
  await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'point' });
  await call('xr', 'set-transform', { device: 'hand-right', position: S.tip, anchor: 'index-tip', orientation: { fingers: [0, -0.85, -0.5], thumb: 'left' } });
  const desk = await until('the desk placement', () => globalThis.__xrApp.desk$.value, null, 120000, 1000);
  // Hand off the sheet again.
  await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.3, y: 0.82, z: S.head.z - 0.15 }, orientation: 'auto' });
  await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'default' });
  // A new guest's first round with a sheet teaches the gesture first; runs about something else skip it.
  if (onboarding === 'skip') await skipOnboarding();
  return desk;
}

/** The first-round onboarding step on the sheet, if one is showing ('box'). */
export const onboardingStep = () => page(() => globalThis.__round?.room?.debug?.onboarding?.showing?.() ?? null);

/** Skips the first-round onboarding when it shows (a new guest gets it on a round with a sheet). Returns the step skipped. */
export async function skipOnboarding(waitMs = 6000) {
  const end = Date.now() + waitMs;
  for (;;) {
    const step = await onboardingStep().catch(() => null);
    if (step) {
      await page(() => globalThis.__round.room.debug.onboarding.skip());
      stage('onboarding skipped', { step });
      return step;
    }
    const st = await page(() => globalThis.__round?.controller.state).catch(() => null);
    if (st && st !== 'placing') return null;
    if (Date.now() > end) return null;
    await sleep(700);
  }
}

export const look = (S, pitch, yaw = 0) => call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch, yaw, roll: 0 } });

export const SETUPS = {
  // Desk top 0.74 m, near edge z -1.7, against the back wall.
  home_office: { head: { x: 0.0, y: 1.2, z: -1.5 }, tip: { x: 0.04, y: 0.748, z: -1.74 } },
  // Table top 0.74 m, near end z -1.0, centred on x = 0.
  conference_room: { head: { x: 0.0, y: 1.2, z: -0.72 }, tip: { x: 0.02, y: 0.748, z: -1.06 } },
};

// ---- drawing on the sheet with the right hand ----

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function along(corners, step) {
  const out = [];
  for (let i = 0; i + 1 < corners.length; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const k = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 0; j < k; j++) out.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k]);
  }
  out.push(corners[corners.length - 1]);
  return out;
}
export function roughBox(x, y, w, h, seed) {
  const r = rng(seed);
  const sx = x + w * 0.3;
  return along([[sx, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y], [sx + 0.8, y]], 1.5).map(([px, py]) => [px + (r() - 0.5) * 0.6, py + (r() - 0.5) * 0.6]);
}

const r4 = (p) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4, z: Math.round(p.z * 1e4) / 1e4 });
const toWorld = (pts, h) => page((a) => globalThis.__round.room.debug.toWorld(a.pts, a.h), { pts, h });

/**
 * Pinch-draws a stroke through board points (cm), 1 cm above the sheet. `rest` (seconds) waits over the first point
 * before the pinch: the board takes a pinch's place from the last frame it saw, and at the emulator's two or three
 * frames a second in a round that frame can still be from the middle of the reach, centimetres away. A stroke that
 * must start in a narrow band (a connector from a card's edge) rests first, as a hand does.
 */
export async function draw(points, segment = 0.1, { rest = 0.3, hold = 0.15, end = 0.25 } = {}) {
  const w = (await toWorld(points, 1)).map(r4);
  const last = w[w.length - 1];
  const steps = [
    { label: 'reach', position: w[0], anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: rest },
    { label: 'pinch', pinch: 1, duration: 0.15 },
    { label: 'hold', duration: hold },
    ...w.slice(1).map((p, i) => ({ label: `p${i}`, position: p, duration: segment })),
    { label: 'hold end', duration: end },
    { label: 'release', pinch: 0, duration: 0.15 },
    { label: 'lift', position: { x: last.x, y: last.y + 0.06, z: last.z }, duration: 0.3 },
  ];
  return xr('run-sequence', { device: 'hand-right', steps, body: 'auto', gaze: 'fixed', idleHand: 'keep' });
}

/** A quick pinch on a board point (accept a ghost). `rest` (seconds) waits over it first. */
export async function tap(x, y, rest = 0.3) {
  const [p] = (await toWorld([[x, y]], 1)).map(r4);
  const steps = [
    { label: 'reach', position: p, anchor: 'grasp', duration: 0.6, pinch: 0 },
    { label: 'settle', duration: rest },
    { label: 'pinch', pinch: 1, duration: 0.12 },
    { label: 'release', pinch: 0, duration: 0.12 },
    { label: 'lift', position: { x: p.x, y: p.y + 0.06, z: p.z }, duration: 0.3 },
  ];
  return xr('run-sequence', { device: 'hand-right', steps, body: 'auto', gaze: 'fixed', idleHand: 'keep' });
}

/**
 * Where the scripted pinch lands against where the hand is sent, near (x, y) on empty sheet (board cm): [dx, dy]. The
 * emulator places its hand by a grasp point that is not the thumb and index tips the app reads, and how far apart they
 * are depends on how the hand is turned (1 to 2 cm here). A person aims by sight; the script aims by the app's own
 * reading of a tap that makes no mark. Null when no pinch was seen.
 */
export async function pinchOffset(x, y) {
  // Never on a suggestion (a tap there would accept it) or a card.
  const busy = (q) =>
    page((a) => {
      const d = globalThis.__round.room.debug;
      const b = d.store.board;
      const inR = (r) => r && a.x >= r.x - 2 && a.x <= r.x + r.w + 2 && a.y >= r.y - 2 && a.y <= r.y + r.h + 2;
      return b.ghosts.some((g) => inR(d.ghostRect(g.op_id))) || b.items.some((i) => i.w && inR(i));
    }, { x: q[0], y: q[1] });
  for (const dy of [0, 6, -12, 12]) {
    if (!(await busy([x, y + dy]))) {
      y += dy;
      break;
    }
  }
  const n = await page(() => globalThis.__round.room.debug.pinches?.().length ?? 0);
  await tap(x, y, 1.5);
  await sleep(800);
  const d = await page((i) => globalThis.__round.room.debug.pinches?.()[i] ?? null, n);
  return d ? [Math.round((d.x_cm - x) * 100) / 100, Math.round((d.y_cm - y) * 100) / 100] : null;
}

export const board = () =>
  page(() => {
    const s = globalThis.__round?.room?.debug?.store;
    if (!s) return null;
    const b = s.board;
    return {
      rev: b.rev,
      items: b.items.map((i) => ({ id: i.id, kind: i.kind, type: i.type ?? null, label: i.label ?? null, x: i.x, y: i.y, w: i.w, h: i.h })),
      edges: b.edges.map((e) => [e.from, e.to, e.dir]),
      ghosts: b.ghosts.map((g) => ({ op_id: g.op_id, op: g.op })),
      log: s.log.map((e) => ({ src: e.op.src, op: e.op.op, accepted: e.accepted, local: !!e.local, confirmed: e.confirmed ?? null })),
    };
  });

export { call, sleep, screenshot };
