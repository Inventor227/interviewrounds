// The real-voice smoke: one short round in the emulator against the deployed server with the Fish voice (billed,
// about $0.07 a minute per open voice). The candidate's lines are played into the page's microphone as speech
// (e2e/voice/*.wav from make-voice.py), so the voice service hears them, ends each turn itself and transcribes it;
// SPEECH=typed sends them as typed turns instead. The round is recorded (?record=1: timeline, one audio file per
// voice, the candidate's speech, a mix) and the screen is captured to a video, for the demo.
//
//   ROUND=behavioral|design|meeting  VIEW=preview|xr  SPEECH=voice|typed  MAX_MIN=<hard stop, default 6>
//   FISH_OK=1 must be set: without it the script refuses to start.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/fish-round.mjs --size 1280x720 --env-file <env> --timeout 30 \
//     --out plan/video/raw/<round>
//
// Every voice this opens is ended on the way out, also when a step fails (the round is ended, then the page leaves).
// The run prints the Fish session ids (never a token) so they can be checked from outside.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.EMU_APP_DIR;
copyFileSync(path.join(APP, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { click, go, look, page, placeDesk, sleep, stage, until, waitState } = L;

// FAKE=1: the same run with the typed-turn fake voice (dev key from the env file, nothing billed), to check the script.
const FAKE = process.env.FAKE === '1';
if (process.env.FISH_OK !== '1' && !FAKE) {
  console.error('fish-round: FISH_OK=1 is not set; this run spends money on the voice service. Refusing.');
  process.exit(2);
}
const ROUND = process.env.ROUND ?? 'behavioral';
const VIEW = process.env.VIEW ?? 'preview';
const SPEECH = FAKE ? 'typed' : (process.env.SPEECH ?? 'voice');
const MAX_MS = Number(process.env.MAX_MIN ?? 6) * 60_000;
const SHOTS = process.env.EMU_SHOTS;
const ROUNDS = {
  behavioral: { path: '/round/sde.behavioral.short', room: 'home_office' },
  design: { path: '/round/sde.system_design.short', room: 'home_office' },
  meeting: { path: '/meeting/new?template=investor_pitch', room: 'conference_room' },
};
const R = ROUNDS[ROUND];
if (!R) throw new Error(`unknown ROUND ${ROUND}`);
const lines = JSON.parse(readFileSync(path.join(APP, 'e2e', 'fish-lines.json'), 'utf8'))[ROUND];

// The candidate's speech is served by the dev server from public/ on this server copy only.
const voiceDir = path.join(APP, 'public', '__emu_voice');
mkdirSync(voiceDir, { recursive: true });
for (const f of readdirSync(path.join(APP, 'e2e', 'voice'))) copyFileSync(path.join(APP, 'e2e', 'voice', f), path.join(voiceDir, f));

const out = { round: ROUND, view: VIEW, speech: SPEECH, turns: [], fish_sessions: [], notes: [] };
const t0 = Date.now();
const save = () => writeFileSync(path.join(SHOTS, 'run.json'), JSON.stringify({ ...out, stages: L.stages }, null, 2));

async function shot(name) {
  try {
    await L.screenshot(name);
    stage(`shot ${name}`);
  } catch (e) {
    stage(`shot ${name} failed`, String(e.message ?? e).slice(0, 200));
  }
}

// ---------- screen video (CDP screencast into Playwright's own ffmpeg, constant 5 fps) ----------
// `iwsdk browser run` executes its module in a CLI process of its own: the capture lives as long as that process, so
// it runs in the background for the whole round and stops when the stop file appears.

const STOP_FILE = path.join(SHOTS, '..', 'cast.stop');
/** The tooling allows a browser script 110 s, so the capture runs as consecutive parts of at most 100 s each. */
const PART_MS = 100_000;
let castLoop = null;
function castModule(out) {
  return `import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
export default async function ({ page }) {
  const root = '/ms-playwright';
  const ff = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith('ffmpeg')).map((d) => root + '/' + d + '/ffmpeg-linux').find((p) => existsSync(p)) : null;
  if (!ff) return 'no ffmpeg';
  const out = ${JSON.stringify(out)};
  const proc = spawn(ff, ['-loglevel', 'error', '-f', 'image2pipe', '-framerate', '5', '-c:v', 'mjpeg', '-i', 'pipe:0', '-an', '-c:v', 'vp8', '-b:v', '1500k', '-deadline', 'realtime', '-speed', '6', '-vf', 'scale=1280:720', '-y', out], { stdio: ['pipe', 'ignore', 'ignore'] });
  const s = await page.context().newCDPSession(page);
  let latest = null, frames = 0, written = 0, firstAt = null;
  s.on('Page.screencastFrame', async (f) => {
    latest = Buffer.from(f.data, 'base64');
    frames++;
    try { await s.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch {}
  });
  await s.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 720 });
  const startedAt = Date.now();
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (latest) {
        if (firstAt === null) firstAt = Date.now();
        written++;
        try { proc.stdin.write(latest); } catch {}
      }
      if (existsSync(${JSON.stringify(STOP_FILE)}) || Date.now() - startedAt > ${PART_MS}) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });
  try { await s.send('Page.stopScreencast'); } catch {}
  try { await s.detach(); } catch {}
  await new Promise((r) => { proc.on('close', r); proc.stdin.end(); setTimeout(r, 5000); });
  const meta = { file: out.split('/').pop(), fps: 5, first_frame_epoch_ms: firstAt, frames_written: written, screencast_frames: frames };
  writeFileSync(out.replace(/\\.webm$/, '.video.json'), JSON.stringify(meta, null, 2));
  return meta;
}
`;
}

function castStart(name) {
  const bin = path.join(APP, 'node_modules', '.bin', 'iwsdk');
  const parts = [];
  const runPart = (n) =>
    new Promise((resolve) => {
      const file = path.join(L.DIR, `cast-${n}.mjs`);
      writeFileSync(file, castModule(path.join(SHOTS, `${name}-${String(n).padStart(2, '0')}.webm`)));
      const proc = spawn(bin, ['browser', 'run', path.relative(APP, file), '--timeout', '108000'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      proc.stdout.on('data', (d) => (log += d));
      proc.stderr.on('data', (d) => (log += d));
      proc.on('exit', (code) => resolve({ part: n, code, log: code ? log.slice(-300) : undefined }));
    });
  castLoop = (async () => {
    for (let n = 1; n <= 30 && !existsSync(STOP_FILE); n++) parts.push(await runPart(n));
    return parts;
  })();
  return { started: true, name };
}

async function castStop() {
  if (!castLoop) return null;
  writeFileSync(STOP_FILE, 'stop');
  const r = await Promise.race([castLoop, sleep(30000).then(() => ({ timeout: true }))]);
  castLoop = null;
  return r;
}

// ---------- the tab: recording on, a microphone the script can speak into ----------

async function setupTab() {
  if (FAKE) {
    // The key goes from the driver's env straight into the tab's storage; it is never written to a file.
    await L.play(`return await frame.evaluate((k) => (sessionStorage.setItem('ir_dev_key', k), true), process.env.DEV_KEY);`);
    // The page read its voice choice before the key was there: load it again.
    await go(await page(() => location.pathname + location.search));
  }
  const ok = await page((fake) => {
    if (!fake) sessionStorage.removeItem('ir_dev_key'); // the real voice: no dev key in this tab
    sessionStorage.setItem('ir_record', '1');
    sessionStorage.setItem('ir_offer', '1');
    sessionStorage.setItem('ir_fallback', '180');
    sessionStorage.setItem('ir_one_world', '1');
    const ctx = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();
    navigator.mediaDevices.getUserMedia = async () => new MediaStream(dest.stream.getAudioTracks().map((t) => t.clone()));
    const sp = (globalThis.__speech = { ctx, dest, src: null, said: [] });
    sp.say = async (url, id) => {
      await ctx.resume().catch(() => undefined);
      const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      const rec = globalThis.__recorder;
      const startT = rec?.now() ?? null;
      rec?.event('candidate.speech_start', { id, seconds: Math.round(buf.duration * 10) / 10 });
      sp.src = src;
      const done = new Promise((r) => (src.onended = r));
      src.start();
      sp.current = { id, startedAt: Date.now(), seconds: buf.duration, done };
      done.then(() => {
        if (sp.src === src) sp.src = null;
        rec?.event('candidate.speech_end', { id, cut: !!sp.cut });
        sp.said.push({ id, start_t: startT, end_t: rec?.now() ?? null, cut: !!sp.cut, endedAt: Date.now() });
        sp.cut = false;
      });
      return Math.round(buf.duration * 1000);
    };
    sp.stop = () => {
      if (!sp.src) return false;
      sp.cut = true;
      globalThis.__recorder?.event('candidate.yield');
      sp.src.stop();
      return true;
    };
    if (fake) Object.defineProperty(globalThis, 'speechSynthesis', { value: undefined, configurable: true });
    return 'ok';
  }, FAKE);
  if (ok !== 'ok') throw new Error(`tab setup failed: ${JSON.stringify(ok)}`);
}

/** The voice modes and the agent lines so far, from the recording. */
const recState = () =>
  page(() => {
    const r = globalThis.__recorder;
    const c = globalThis.__round?.controller;
    if (!r || !c) return null;
    const ev = r.events;
    const agent = ev.filter((e) => e.kind === 'voice.agent_text');
    const last = agent.at(-1);
    const speaking = [...ev].reverse().find((e) => e.kind === 'voice.mode');
    return {
      state: c.state,
      floor: c.floor,
      now: r.now(),
      agentCount: agent.length,
      lastAgentT: last?.t ?? null,
      lastAgentText: last?.text ?? null,
      lastMode: speaking ? { panelist: speaking.panelist, mode: speaking.mode, t: speaking.t } : null,
    };
  });

/** Waits until the interviewers have said something new and then gone quiet for quietMs. */
async function waitReply(beforeCount, { timeoutMs = 60_000, quietMs = 3500 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    await sleep(800);
    const s = await recState().catch(() => null);
    if (s && !['live', 'greeting', 'paused'].includes(s.state)) return { ended: s.state };
    if (s && s.agentCount > beforeCount && s.now - s.lastAgentT > quietMs && s.lastMode?.mode !== 'speaking') return s;
    if (Date.now() > end) return { timeout: true, s };
  }
}

/** Says one line (speech into the mic, or a typed turn) and waits for the reply. */
async function turn(line, { yieldToAgent = false } = {}) {
  const before = (await recState())?.agentCount ?? 0;
  const startedAt = Date.now();
  let ms = 0;
  if (SPEECH === 'typed') {
    await page((t) => {
      globalThis.__recorder?.event('candidate.typed', { text: t });
      globalThis.__round.controller.sendTypedTurn(t);
    }, line.text);
  } else {
    ms = await page(([u, id]) => globalThis.__speech.say(u, id), [`/__emu_voice/${line.id}.wav`, line.id]);
    // While it plays: a long answer lets the interviewer cut in (and stops talking when they do).
    const until = Date.now() + ms + 500;
    while (Date.now() < until) {
      await sleep(700);
      if (!yieldToAgent) continue;
      const s = await recState().catch(() => null);
      if (s?.lastMode?.mode === 'speaking' && s.agentCount > before) {
        const cut = await page(() => globalThis.__speech.stop());
        stage('the interviewer cut in; the candidate stopped', { line: line.id, after_s: Math.round((Date.now() - startedAt) / 100) / 10, cut });
        break;
      }
    }
  }
  const reply = await waitReply(before, { timeoutMs: yieldToAgent ? 90_000 : 60_000 });
  const rec = { line: line.id, speech_ms: ms, reply_text: reply.lastAgentText ?? null, reply_from: reply.lastMode?.panelist ?? null, ended: reply.ended ?? null, timeout: !!reply.timeout };
  out.turns.push(rec);
  stage(`turn ${line.id}`, rec);
  save();
  return reply;
}

const overTime = () => Date.now() - (out.startedAt ?? Date.now()) > MAX_MS;

async function endRound(reason) {
  const st = await page(() => globalThis.__round?.controller.state).catch(() => null);
  if (st && ['live', 'greeting', 'paused', 'placing'].includes(st)) {
    stage('ending the round', { reason, state: st });
    await page(() => globalThis.__round.controller.end()).catch(() => undefined);
  }
}

async function collectFish() {
  const ids = await page(() => (globalThis.__round?.session?.panel ?? []).map((p) => ({ panelist: p.panelist_id, name: p.display_name, fish_session_id: p.voice?.fish?.session_id ?? null }))).catch(() => []);
  for (const f of ids) if (f.fish_session_id && !out.fish_sessions.some((x) => x.fish_session_id === f.fish_session_id)) out.fish_sessions.push(f);
  // Voices joined later (swap hand-overs) are in the recording's frames and panel joins.
  const more = await page(() => {
    const r = globalThis.__recorder;
    const seen = new Set();
    for (const e of r?.events ?? []) {
      const s = JSON.stringify(e);
      for (const m of s.matchAll(/"session_id":"([A-Za-z0-9_-]{8,})"/g)) seen.add(m[1]);
    }
    return [...seen];
  }).catch(() => []);
  out.fish_seen_ids = more;
}

async function saveRecording() {
  const done = await page(async (extra) => {
    const r = globalThis.__recorder;
    if (!r) return null;
    const store = globalThis.__round?.room?.debug?.store;
    const board = store ? { rev: store.board.rev, items: store.board.items, edges: store.board.edges, log: store.log.map((e) => ({ ...e })) } : null;
    const said = globalThis.__speech?.said ?? [];
    const { timeline, audio } = await r.finish({ ...extra, board, candidate_speech: said });
    globalThis.__recDone = { timeline, audio };
    return { timeline, files: audio.map((a) => a.file) };
  }, { room: R.room, view: VIEW, speech: SPEECH, emulator: true, candidate_lines: lines }, 60_000);
  if (!done) return null;
  writeFileSync(path.join(SHOTS, 'timeline.json'), JSON.stringify(done.timeline, null, 2));
  for (const f of done.files) {
    const b64 = await page((name) => globalThis.__recorder.audioBase64(name), f, 60_000).catch((e) => (out.notes.push(`audio ${f}: ${String(e).slice(0, 200)}`), null));
    if (b64) writeFileSync(path.join(SHOTS, f), Buffer.from(b64, 'base64'));
    else out.notes.push(`audio ${f}: empty`);
  }
  return done.files;
}

// ---------- the run ----------

let failed = null;
try {
  await waitReady();
  await L.play(`await page.setViewportSize({ width: 1280, height: 720 }); return true;`).catch(() => undefined);
  await go(VIEW === 'preview' ? `${R.path}${R.path.includes('?') ? '&' : '?'}preview=1` : R.path);
  await setupTab();

  if (ROUND === 'meeting') {
    await until('the meeting setup', () => !!document.querySelector('[data-test="prepare"]'));
    await shot('01-meeting-setup');
    await click('prepare');
    await until('the prepared meeting', () => !!document.querySelector('[data-test="prepared"]'), null, 120000);
    await sleep(1000);
    await shot('02-meeting-prepared');
    await page(() => document.querySelector('[data-test="prepared"]')?.scrollIntoView({ block: 'start' }));
    await sleep(500);
    await shot('02b-meeting-plan');
  } else {
    await until('the start page', () => !!document.querySelector('[data-test="mic-allow"]'));
    await shot('01-start');
  }

  // Tap 1: the microphone, the session (its voices are made now; they open at Enter).
  await click('mic-allow');
  stage('speech context', await page(() => globalThis.__speech.ctx.resume().then(() => globalThis.__speech.ctx.state)));
  const startSel = VIEW === 'preview' ? 'start-preview' : 'start-round';
  await until('ready to start', (sel) => !!document.querySelector(`[data-test="${sel}"]:not([disabled])`), startSel, 150000);
  await shot('02-ready');
  rmSync(STOP_FILE, { force: true });
  const video = castStart(`${ROUND}-screen`);
  stage('screen video', video);

  // Tap 2: the voices connect, the round starts.
  out.startedAt = Date.now();
  await click(startSel);
  if (VIEW === 'xr') {
    await sleep(3000);
    await L.recordRound();
    await placeDesk(L.SETUPS[R.room]);
    await look(L.SETUPS[R.room], -14);
  } else {
    await L.recordRound();
    // The room on screen (the video shows it, not the page header).
    await page(() => (document.querySelector('[data-test="session-stage"]')?.scrollIntoView({ block: 'center' }), true)).catch(() => undefined);
  }
  // The candidate's microphone is part of the recording too.
  await page(() => globalThis.__recorder?.attachAudio('candidate', globalThis.__speech.dest.stream));
  await waitState(['live'], 120000);
  const greet = await waitReply(0, { timeoutMs: 60_000 });
  stage('greeted', { text: greet.lastAgentText, from: greet.lastMode?.panelist });
  await shot('03-greeted');
  await collectFish();
  save();

  for (const [i, line] of lines.entries()) {
    if (overTime()) {
      out.notes.push(`hard stop after ${MAX_MS / 60000} min`);
      break;
    }
    const st = await recState();
    if (!st || st.state !== 'live') break;
    const r = await turn(line, { yieldToAgent: line.id === 'd3' });
    if (r.ended) break;
    if (i === 0) await shot('04-first-reply');
    if (ROUND === 'meeting' && line.id === 'm3') {
      // The ask to Tom: the server hands the floor over and Tom's own voice joins.
      const fl = await until('the floor to move', () => {
        const c = globalThis.__round.controller;
        return c.floor !== 'p1' && c.floor !== globalThis.__round.session.floor ? c.floor : null;
      }, null, 60000, 1500).catch(() => null);
      stage('hand-over', { floor: fl });
      await shot('05-hand-over');
      await collectFish();
    }
  }
  await shot('06-before-end');
} catch (e) {
  failed = String(e.stack ?? e).slice(0, 2000);
  console.error('fish-round failed:', failed);
} finally {
  // Whatever happened: end the round, so the server ends every voice it opened.
  await endRound(failed ? 'failure' : 'done').catch(() => undefined);
}

try {
  await waitState(['scoring', 'summary'], 60000);
  await until('the quick card or the summary', () => (globalThis.__xrApp?.ui.summary.group.visible ? true : null), null, 150000, 2000).catch(() => null);
  await sleep(1500);
  await shot('07-quick-card');
  await waitState(['summary'], 240000).catch(() => undefined);
  await shot('08-summary');
} catch (e) {
  out.notes.push(`after the round: ${String(e.message ?? e).slice(0, 300)}`);
}
await collectFish();
out.video = await castStop();
out.recordingFiles = await saveRecording().catch((e) => (out.notes.push(`recording: ${String(e).slice(0, 300)}`), null));
out.timings = await page(() => globalThis.__round?.timings?.() ?? null).catch(() => null);
const sid = await page(() => globalThis.__round?.session?.session_id ?? null).catch(() => null);
out.session_id = sid;
save();

// The 2D pages after the round (no voice is open any more): report, history, share.
try {
  if (sid) {
    await go(`/report/${sid}`);
    await until('the report', () => (document.querySelector('[data-test="page-report"] [data-test="verdict"]') ? true : null), null, 240000, 3000);
    await sleep(1500);
    await shot('10-report-top');
    const height = await page(() => document.documentElement.scrollHeight);
    for (let y = 700, n = 1; y < height && n <= 6; y += 650, n++) {
      await page((yy) => window.scrollTo(0, yy), y);
      await sleep(600);
      await shot(`11-report-${n}`);
    }
    await go('/history');
    await sleep(2500);
    await shot('12-history');
    await go(`/report/${sid}`);
    await until('the report', () => (document.querySelector('[data-test="share-toggle"]') ? true : null), null, 60000, 2000);
    await page(() => document.querySelector('[data-test="share"]')?.scrollIntoView({ block: 'center' }));
    await click('share-toggle').catch(() => undefined);
    const url = await until('the share link', () => document.querySelector('[data-test="share-link"] input')?.value || null, null, 30000).catch(() => null);
    await sleep(800);
    await shot('11z-report-share');
    out.share = url ? url.replace(/^https?:\/\/[^/]+/, '') : null;
    if (out.share) {
      // The public page refuses to be framed: open it in a tab of its own (the tooling's page is a frame).
      const shotFile = path.join(SHOTS, '13-share-page.png');
      out.sharePage = await L.play(`
        const p = await page.context().newPage();
        await p.setViewportSize({ width: 1280, height: 720 });
        await p.goto(new URL(${JSON.stringify(out.share)}, frame.url()).href, { waitUntil: 'load' });
        await p.waitForTimeout(2500);
        await p.screenshot({ path: ${JSON.stringify(shotFile)}, fullPage: true });
        const title = await p.title();
        await p.close();
        return title;`, 60000).catch((e) => `failed: ${String(e).slice(0, 200)}`);
    }
  }
} catch (e) {
  out.notes.push(`2D pages: ${String(e.message ?? e).slice(0, 300)}`);
}
out.failed = failed;
out.wall_s = Math.round((Date.now() - t0) / 1000);
save();
console.log('fish sessions', JSON.stringify(out.fish_sessions), JSON.stringify(out.fish_seen_ids ?? []));
console.log(failed ? 'fish round FAILED' : 'fish round ok');
process.exit(failed ? 1 : 0);
