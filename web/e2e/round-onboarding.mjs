// The first five minutes, end to end in the emulator against the deployed server with the typed-turn fake voice:
// a new guest's first design round. After the desk is placed the ghost hand shows "Pinch and draw a box" and the
// interviewer waits (no hello, no greeting) until the user has drawn one box (or 20 s have passed); then the round
// starts. A second round in the same tab has no onboarding. Then: leaving the headset view during placement.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-onboarding.mjs --env-file <env file> --timeout 40 --out plan/shots/t21/onboarding
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterXR, waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { board, click, draw, enterFromTap, fail, go, look, onboardingStep, page, placeDesk, recordRound, roughBox, roundState, save, setupTab, shot, sleep, stage, until, waitState } = L;

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;
const out = {};
const started = () => page(() => ({ state: globalThis.__round.controller.state, hello: globalThis.__round.controller.started, lines: globalThis.__rec.lines.length }));

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab();
// As in the other round runs: a capture of the page before the room exists (the managed browser draws its first frames for it).
await shot('00-home');
out.meBefore = await page(() => fetch('/api/me').then((r) => r.json()).then((m) => ({ onboarding_done: m.onboarding_done, kind: m.identity.kind })));
stage('a new guest', out.meBefore);
await click('try-quick');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await shot('00-ready');
await enterFromTap('start-round');
await recordRound();

// ---- the first round: the gesture is taught before anyone speaks ----
await placeDesk(S, '01-placing', { onboarding: 'keep' });
await until('the box step', () => (globalThis.__round.room.debug?.onboarding?.showing?.() === 'box' ? true : null), null, 20000, 500);
await look(S, -48);
await sleep(1200);
await shot('02-ghost-hand');
out.waiting = [];
for (let i = 0; i < 2; i++) {
  await sleep(2000);
  out.waiting.push(await started());
}
stage('the interviewer waits', out.waiting);
if (out.waiting.some((w) => w.state !== 'placing' || w.hello || w.lines > 0)) await fail('the round started before the box', out.waiting);
await shot('03-ghost-hand-later');
out.view = await page(() => {
  const v = globalThis.__round.room.debug.onboarding.view;
  return { card: globalThis.__xrApp.ui.status.view, hand: v.group.getObjectByName('ghost-hand').visible, calls: globalThis.__xrApp.stats().callsPerView };
});

if (process.env.SHOTS_ONLY === '1') {
  // A look at the ghost hand and the line only: skip (one pinch on Skip is the same call) and stop.
  // Skip through the card's own button action (what a poke, a pinch or a trigger on it sends).
  out.skip = await page(() => {
    globalThis.__xrApp.ui.emit('skip');
    return globalThis.__round.room.debug.onboarding.showing();
  });
  await waitState(['live'], 120000);
  stage('skipped', { ...out, ...(await started()) });
  // A controller instead of hands: the ray on the paused card's Resume and the trigger must do what a pinch does.
  await page(() => globalThis.__round.controller.pause('user'));
  await look(S, -32);
  await sleep(1500);
  const target = await page(() => {
    const g = globalThis.__xrApp.ui.status.group;
    g.updateWorldMatrix(true, false);
    const v = g.position.clone().set(-0.068, -0.03, 0.002);
    g.localToWorld(v);
    return { x: v.x, y: v.y, z: v.z };
  });
  const d = { x: S.head.x - target.x, y: S.head.y - target.y, z: S.head.z - target.z };
  const n = Math.hypot(d.x, d.y, d.z);
  const from = { x: target.x + (d.x / n) * 0.25 + 0.03, y: target.y + (d.y / n) * 0.25 - 0.03, z: target.z + (d.z / n) * 0.25 };
  await L.call('xr', 'set-input-mode', { mode: 'controller' });
  await L.call('xr', 'set-transform', { device: 'controller-right', position: from });
  await L.call('xr', 'look-at', { device: 'controller-right', target });
  await sleep(2000);
  const dev = await L.call('xr', 'get-transform', { device: 'controller-right' }).catch((e) => String(e).slice(0, 200));
  await shot('09-controller-ray-on-resume');
  const before = await page(() => globalThis.__round.controller.state);
  await L.call('xr', 'select', { device: 'controller-right', duration: 3 });
  await sleep(5000);
  out.controller = { target, from, dev: JSON.stringify(dev).slice(0, 300), before, after: await page(() => globalThis.__round.controller.state), sources: await page(() => [...globalThis.__xrApp.world.session.inputSources].map((s) => ({ hand: !!s.hand, mode: s.targetRayMode, side: s.handedness }))) };
  stage('controller trigger on Resume', out.controller);
  if (out.controller.after === 'paused') console.error('WARNING: the controller ray and trigger did not press Resume');
  save('round-onboarding-shots', out);
  await page(() => globalThis.__round.controller.end());
  console.log('round onboarding shots ok');
  process.exit(0);
}
const boxAt = Date.now();
await draw(roughBox(24, 22, 14, 9, 3));
const made = await until('the box became a card', () => {
  const b = globalThis.__round.room.debug.store.board;
  return b.items.some((i) => i.kind !== 'ink') ? { items: b.items.map((i) => ({ kind: i.kind, label: i.label ?? null })) } : null;
}, null, 30000, 700);
out.afterBox = { ms: Date.now() - boxAt, step: await onboardingStep(), ...made, ...(await started()) };
stage('one box drawn', out.afterBox);
await waitState(['greeting', 'live'], 60000);
stage('the round started', await started());
await waitState(['live'], 120000);
await look(S, -14);
await sleep(1000);
await shot('05-greeted');
out.first = await page(() => ({ states: globalThis.__rec.states, errors: globalThis.__rec.errors, lines: globalThis.__rec.lines.slice(0, 3).map((l) => ({ role: l.role, text: l.text })), timings: globalThis.__round.timings() }));
out.meAfter = await page(() => fetch('/api/me').then((r) => r.json()).then((m) => ({ onboarding_done: m.onboarding_done })));
stage('first round', { ...out.first, ...out.meAfter });
if (!out.meAfter.onboarding_done) console.error('WARNING: the server did not record the onboarding');

await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 90000);
await sleep(3000);

// ---- a second round in the same tab: no onboarding ----
await page(() => {
  history.pushState({}, '', '/');
  dispatchEvent(new PopStateEvent('popstate'));
  return true;
});
await until('the home page again', () => !!document.querySelector('[data-test="try-quick"]'));
await click('try-quick');
await until('the second round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await enterFromTap('start-round');
await page(() => void delete globalThis.__rec);
await recordRound();

// Leaving the headset view while the desk is being placed: nothing has started, the page offers the way back.
await sleep(1500);
await page(() => void globalThis.__xrApp.world.session.end());
const left = await until('the page offers the way back', () => (document.querySelector('[data-test="return-to-room"]') ? { state: globalThis.__round.controller.state, hello: globalThis.__round.controller.started, text: document.querySelector('main').innerText.slice(0, 300) } : null), null, 30000);
out.leftDuringPlacement = left;
stage('left during placement', left);
if (left.state !== 'placing' || left.hello) await fail('leaving during placement started or ended something', left);
await L.screenshot('06-left-during-placement').catch((e) => console.error('page screenshot failed', String(e).slice(0, 200)));
await click('return-to-room');
await sleep(3000);
if (!(await page(() => !!globalThis.__xrApp?.world.session))) {
  await enterXR();
  await sleep(1500);
  if (await page(() => !!document.querySelector('[data-test="return-to-room"]'))) await click('return-to-room');
  if (await page(() => !!document.querySelector('[data-test="enter-room"]'))) await click('enter-room');
}
await placeDesk(S, '07-placing-again', { onboarding: 'keep' });
const seen = [];
for (let i = 0; i < 4; i++) {
  seen.push(await onboardingStep());
  await sleep(1200);
}
await waitState(['greeting', 'live'], 60000);
out.second = { onboardingSteps: seen, ...(await started()), states: await page(() => globalThis.__rec.states), errors: await page(() => globalThis.__rec.errors) };
stage('second round', out.second);
if (seen.some(Boolean)) await fail('the second round showed the onboarding again', out.second);
await waitState(['live'], 120000);
await look(S, -30);
await sleep(1000);
await shot('08-second-round-no-onboarding');
await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 90000);

save('round-onboarding', out);
console.log('errors', JSON.stringify([...(out.first.errors ?? []), ...(out.second.errors ?? [])]));
console.log('round onboarding ok');
