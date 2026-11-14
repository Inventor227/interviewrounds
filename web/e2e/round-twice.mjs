// Two rounds in one tab, in the emulator against a real server with the typed-turn fake voice: a quick round from
// home to the report page, back home without a reload, then a second quick round: the room is torn down and built
// again, and the headset session is entered a second time.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-twice.mjs --env-file <dev key file> --timeout 35 --out plan/shots/int-web/twice
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, click, enterFromTap, fail, go, look, page, placeDesk, recordRound, roundState, save, setupTab, shot, sleep, stage, until, waitState } = L;

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;
const rounds = [];

async function oneRound(n) {
  if (n > 1) await shot(`${n}-0-home`); // a capture before each headset session
  const tap1 = Date.now();
  await click('try-quick');
  await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
  stage(`round ${n}: ready for enter`, { ms: Date.now() - tap1 });
  await enterFromTap('start-round');
  await page(() => void delete globalThis.__rec);
  await recordRound();
  const session = await page(() => globalThis.__round.session.session_id);
  stage(`round ${n}: in xr`, { session, ...(await roundState()) });
  await placeDesk(S, `${n}-1-placing`);
  await waitState(['live'], 120000);
  await look(S, -14);
  await sleep(1200);
  await shot(`${n}-2-live`);
  stage(`round ${n}: answer`, await answer('I would start by asking who uses it and how much traffic to expect, then sketch the simplest design that works.'));
  await page(() => globalThis.__round.controller.end());
  await waitState(['summary'], 300000);
  await sleep(1000);
  await shot(`${n}-3-summary`);
  const out = await page(() => ({ timings: globalThis.__round.timings(), states: globalThis.__rec.states, errors: globalThis.__rec.errors, stats: globalThis.__xrApp.stats() }));
  rounds.push({ n, session, ...out });
  stage(`round ${n}: done`, out);
  if (out.errors.length) await fail(`round ${n} had errors`, out.errors);
  return session;
}

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab();
// One world on the page (the panels are pressed), and one capture before the headset session: the emulator's room
// needs it to draw.
await page(() => sessionStorage.setItem('ir_one_world', '1'));
await shot('0-home');

const first = await oneRound(1);
// See full report: leaves the headset view; the room is destroyed with the page.
await page(() => globalThis.__xrApp.ui.emit('report'));
await until('the report page', () => (location.pathname.startsWith('/report/') && document.querySelector('[data-test="page-report"]') ? location.pathname : null), null, 60000);
await sleep(3000);
stage('report page', { path: await page(() => location.pathname), roomGone: await page(() => !globalThis.__xrApp && !document.querySelector('[data-test="room-host"]')) });
await L.screenshot('1-4-report').catch((e) => console.error('report screenshot failed', String(e).slice(0, 200)));

// Home again, in the same tab, without a reload.
await page(() => {
  history.pushState({}, '', '/');
  dispatchEvent(new PopStateEvent('popstate'));
  return true;
});
await until('the home page again', () => !!document.querySelector('[data-test="try-quick"]'));
const second = await oneRound(2);
if (second === first) await fail('the second round reused the first session');
const hosts = await page(() => document.querySelectorAll('[data-test="room-host"]').length);
stage('two rounds in one tab', { first, second, roomHosts: hosts });
if (hosts !== 1) await fail('an old room was left in the page', { hosts });
save('round-twice', { rounds });
console.log('round twice ok');
