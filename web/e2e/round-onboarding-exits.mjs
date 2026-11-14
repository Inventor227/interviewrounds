// The onboarding never holds a round, in the emulator against the deployed server with the fake voice: a new
// guest's first design round; the headset view is lost while the ghost hand shows, the user comes back and the line
// and Skip are there again; then nothing is drawn, and after 20 s the round starts by itself.
//   Emulator run (see README.md): env DEV_KEY and IR_API_ORIGIN; allow up to 40 minutes.
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterXR, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { click, enterFromTap, fail, go, look, page, placeDesk, recordRound, save, setupTab, shot, sleep, stage, until, waitState } = L;

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;
const out = {};
const view = () => page(() => ({ state: globalThis.__round.controller.state, hello: globalThis.__round.controller.started, step: globalThis.__round.room.debug?.onboarding?.showing?.() ?? null, card: globalThis.__xrApp.ui.status.view, lines: globalThis.__rec?.lines.length ?? 0 }));

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab();
await shot('00-home');
await click('try-quick');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await shot('00-ready');
await enterFromTap('start-round');
await recordRound();
// The headset view is lost the moment the onboarding shows: armed in the page, because the emulator turns slowly
// and the 20 s limit would pass before a script step could act.
await page(() => {
  const t = setInterval(() => {
    const ob = globalThis.__round?.room?.debug?.onboarding;
    if (ob?.showing?.() !== 'box') return;
    clearInterval(t);
    globalThis.__left = { state: globalThis.__round.controller.state, hello: globalThis.__round.controller.started, card: globalThis.__xrApp.ui.status.view };
    void globalThis.__xrApp.world.session.end();
  }, 100);
});
// The desk touch by hand here (the helper waits for a desk that this run takes away again at once).
await L.call('xr', 'set-input-mode', { mode: 'hand' });
await L.call('xr', 'set-transform', { device: 'headset', position: S.head, orientation: { pitch: -38, yaw: 0, roll: 0 } });
await L.call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'point' });
await L.call('xr', 'set-transform', { device: 'hand-right', position: S.tip, anchor: 'index-tip', orientation: { fingers: [0, -0.85, -0.5], thumb: 'left' } });
await until('the onboarding showed and the view was lost', () => globalThis.__left ?? null, null, 120000, 1000);
await until('the page offers the way back', () => (document.querySelector('[data-test="return-to-room"]') ? true : null), null, 30000);
out.first = await page(() => globalThis.__left);
stage('left while the onboarding showed', out.first);
if (!out.first || out.first.card.title !== 'Pinch and draw a box') await fail('the onboarding was not showing when the view was lost', out.first);
await sleep(25000); // longer than the 20 s limit: nothing may start while the user is out
out.away = await view();
stage('away for 25 s', out.away);
if (out.away.state !== 'placing' || out.away.hello) await fail('the round started while the user was out of the headset', out.away);
await click('return-to-room');
await sleep(3000);
if (!(await page(() => !!globalThis.__xrApp?.world.session))) {
  await enterXR();
  await sleep(1500);
  if (await page(() => !!document.querySelector('[data-test="return-to-room"]'))) await click('return-to-room');
  if (await page(() => !!document.querySelector('[data-test="enter-room"]'))) await click('enter-room');
}
const backAt = Date.now();
await placeDesk(S, '02-placing-again', { onboarding: 'keep' });
out.back = await view();
stage('back in the room', out.back);
if (out.back.state === 'placing' && (out.back.card.title !== 'Pinch and draw a box' || !out.back.card.actions.includes('skip'))) await fail('the line and Skip did not come back', out.back);
await look(S, -48);
await shot('03-line-and-skip-again');

// Nothing is drawn: the round starts by itself.
await waitState(['greeting', 'live'], 90000);
out.started = { msAfterBack: Date.now() - backAt, ...(await view()) };
stage('the round started by itself', out.started);
await waitState(['live'], 120000);
await look(S, -14);
await sleep(1000);
await shot('04-greeted-without-a-box');
out.final = await page(() => ({ states: globalThis.__rec.states, errors: globalThis.__rec.errors, first: globalThis.__rec.lines[0]?.text, me: null }));
out.me = await page(() => fetch('/api/me').then((r) => r.json()).then((m) => ({ onboarding_done: m.onboarding_done })));
stage('done', { ...out.final, ...out.me });
save('round-onboarding-exits', out);
await page(() => globalThis.__round.controller.end());
if (out.final.errors.length) await fail('errors', out.final.errors);
console.log('round onboarding exits ok');
