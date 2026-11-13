// Pause and resume, end to end in the emulator against the deployed server with the typed-turn fake voice:
//   1. the headset comes off during the greeting (XRSession visibility `hidden`), comes back ("Welcome back"), Resume;
//   2. the system menu opens while the interviewer speaks (`visible-blurred`): cut mid-sentence, Resume;
//   3. a long pause by the Pause button (past the server's 45 s voice release): Resume gets new voices;
//   4. the system ends the headset session: the page says the round is paused, Resume round goes back in.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-pause.mjs --env-file <dev key file> --timeout 40 --out plan/shots/t21/pause
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterXR, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, click, enterFromTap, fail, go, look, page, placeDesk, recordRound, roundState, save, setupTab, shot, skipOnboarding, sleep, stage, until, waitState } = L;

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;
const LONG_PAUSE_S = Number(process.env.LONG_PAUSE_S ?? 52);

/** XRSession visibility through the emulator's device (what the Quest does for the system menu and the proximity sensor). */
const visibility = (v) =>
  page((state) => {
    const d = globalThis.IWER_DEVICE ?? globalThis.parent?.IWER_DEVICE;
    if (!d?.updateVisibilityState) return { error: 'no emulator device on the page' };
    d.updateVisibilityState(state);
    return { asked: state };
  }, v);
const card = () =>
  page(() => {
    const r = globalThis.__round;
    const ui = globalThis.__xrApp?.ui;
    return { state: r?.controller.state, notice: r?.controller.notice ?? null, card: ui?.status.view ?? null, bar: ui?.roundBar.group.visible, captions: ui?.captions.rowsShown, xr: globalThis.__xrApp?.world.session?.visibilityState ?? null };
  });
const press = (a) => page((act) => globalThis.__xrApp.ui.emit(act), a);
const agentLines = () => page(() => globalThis.__rec.lines.filter((l) => l.role === 'agent').map((l) => ({ who: l.who, text: l.text })));
async function expectCard(what, want) {
  const c = await until(what, (w) => {
    const r = globalThis.__round;
    return r && r.controller.state === w.state && (r.controller.notice ?? null) === w.notice ? { state: r.controller.state, notice: r.controller.notice ?? null, card: globalThis.__xrApp.ui.status.view } : null;
  }, want, 30000, 700);
  stage(what, c);
  return c;
}

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab();
await click('try-quick');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await enterFromTap('start-round');
await recordRound();
await page(() => {
  const rec = globalThis.__rec;
  rec.notices = [];
  globalThis.__round.controller.on('notice', (n) => rec.notices.push({ n, at: Date.now(), state: globalThis.__round.controller.state }));
});
await placeDesk(S, '00-placing');
await skipOnboarding();

// ---- 1. the headset comes off during the greeting ----
await until('the greeting', () => ['greeting', 'live'].includes(globalThis.__round.controller.state));
const v1 = await visibility('hidden');
if (v1?.error) await fail('cannot set the session visibility', v1);
await expectCard('paused in the greeting (headset off)', { state: 'paused', notice: 'paused' });
const greetingCut = await page(() => ({ states: globalThis.__rec.states, lines: globalThis.__rec.lines.length }));
stage('greeting cut', greetingCut);
if (!greetingCut.states.includes('greeting') || greetingCut.states.includes('live')) console.error('WARNING: the pause did not land inside the greeting', greetingCut.states);
await sleep(4000);
await visibility('visible');
await expectCard('welcome back, still paused', { state: 'paused', notice: 'welcome_back' });
await look(S, -30);
await sleep(1200);
await shot('01-greeting-welcome-back');
await sleep(5000);
if ((await roundState()).state !== 'paused') await fail('the round resumed by itself', await roundState());
await press('resume');
await waitState(['live'], 120000);
await sleep(6000);
stage('resumed after the greeting pause', { lines: await agentLines(), card: await card() });
await look(S, -14);
await shot('02-greeting-resumed');

// ---- 2. the system menu opens while the interviewer speaks ----
const before = (await agentLines()).length;
await page((t) => globalThis.__round.controller.sendTypedTurn(t), 'Before I draw anything: I assume about a hundred million new links a day and reads far above writes. Is that right?');
await until('the interviewer speaking', (b) => {
  const agent = globalThis.__rec.lines.filter((l) => l.role === 'agent');
  return agent.length > b && agent.at(-1).text.length > 12 ? { text: agent.at(-1).text } : null;
}, before, 60000, 400);
await visibility('visible-blurred');
await expectCard('paused mid sentence (system menu)', { state: 'paused', notice: 'paused' });
const cut = (await agentLines()).at(-1);
await sleep(5000);
const after = (await agentLines()).at(-1);
stage('speech cut', { cut, after, grewWhilePaused: after.text.length > cut.text.length, card: await card() });
if (after.text.length > cut.text.length + 2) console.error('WARNING: the interviewer went on speaking after the pause', { cut, after });
await look(S, -30);
await sleep(800);
await shot('03-blurred-paused');
await visibility('visible');
await expectCard('welcome back after the menu', { state: 'paused', notice: 'welcome_back' });
await press('resume');
await waitState(['live'], 60000);
await sleep(9000);
stage('resumed after the menu', { lines: (await agentLines()).slice(-2), card: await card() });

// ---- 3. a long pause by the button: the server releases the voices, Resume gets new ones ----
await press('pause');
await expectCard('paused by the button', { state: 'paused', notice: 'paused' });
await look(S, -30);
await sleep(800);
await shot('04-paused-card');
stage(`waiting ${LONG_PAUSE_S} s for the voice release`);
await sleep(LONG_PAUSE_S * 1000);
const token = await page(() => globalThis.__round.session.client_token.slice(0, 6));
const resumeAt = Date.now();
await press('resume');
await waitState(['live'], 60000);
const back = await page((t0) => {
  const rec = globalThis.__rec;
  const live = rec.notices.filter((x) => x.at >= t0 - 200);
  return { notices: live.map((x) => ({ n: x.n, ms: x.at - t0 })), newToken: globalThis.__round.session.client_token.slice(0, 6) };
}, resumeAt);
stage('resumed after the long pause', { ms: Date.now() - resumeAt, tokenChanged: back.newToken !== token, ...back });
if (!back.notices.some((x) => x.n === 'reconnecting')) console.error('WARNING: no reconnect on the long pause (the voices were not released?)', back);
await sleep(9000);
stage('welcome back line', { lines: (await agentLines()).slice(-1) });
await look(S, -14);
await shot('05-long-pause-resumed');
const r3 = await answer('Yes. I would put a cache in front of the key value store for the reads.');
stage('an answer after the reconnect', r3);

// ---- 4. the system ends the headset session: the page holds the way back ----
await page(() => void globalThis.__xrApp.world.session.end());
await until('the page offers Resume round', () => (document.querySelector('[data-test="resume-offer"]') ? { text: document.querySelector('[data-test="resume-offer"]').innerText, state: globalThis.__round.controller.state } : null), null, 30000);
stage('headset session ended', { page: await page(() => document.querySelector('main')?.innerText.slice(0, 400)), ...(await roundState()) });
await L.screenshot('06-page-paused').catch((e) => console.error('page screenshot failed', String(e).slice(0, 200)));
await click('resume-round');
await sleep(3000);
if (!(await page(() => !!globalThis.__xrApp?.world.session))) {
  // The emulator has no user activation for the tap: accept the offered session, then tap again.
  await enterXR();
  await sleep(1500);
  if (await page(() => !!document.querySelector('[data-test="resume-round"]'))) await click('resume-round');
}
await placeDesk(S, '07-placing-again');
await waitState(['live'], 90000);
await sleep(8000);
stage('back in the room', { lines: (await agentLines()).slice(-1), card: await card() });
await look(S, -14);
await shot('08-back-in-the-room');

await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 90000);
const final = await page(() => ({ rec: globalThis.__rec, session: globalThis.__round.session.session_id }));
save('round-pause', final);
console.log('states', JSON.stringify(final.rec.states));
console.log('notices', JSON.stringify(final.rec.notices.map((x) => x.n)));
console.log('errors', JSON.stringify(final.rec.errors));
if (final.rec.errors.length) await fail('the round reported errors', final.rec.errors);
console.log('round pause ok');
