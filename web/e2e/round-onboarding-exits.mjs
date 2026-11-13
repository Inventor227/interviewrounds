// The onboarding never holds a round, in the emulator against the deployed server with the fake voice: a new
// guest's first design round; the headset view is lost while the ghost hand shows, the user comes back and the line
// and Skip are there again; then nothing is drawn, and after 20 s the round starts by itself.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-onboarding-exits.mjs --env-file <env file> --timeout 40 --out plan/shots/t21/onboarding-exits
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
await placeDesk(S, '01-placing', { onboarding: 'keep' });
await until('the box step', () => (globalThis.__round.room.debug?.onboarding?.showing?.() === 'box' ? true : null), null, 20000, 500);
out.first = await view();
stage('onboarding showing', out.first);

// The headset view is lost during the onboarding.
await page(() => void globalThis.__xrApp.world.session.end());
await until('the page offers the way back', () => (document.querySelector('[data-test="return-to-room"]') ? true : null), null, 30000);
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
