// End to end in the emulator for any round by id (ROUND_ID in the env file; default the short coding round): Start
// page → mic and room → Enter → touch the desk → greeting → one typed answer → shots of the sheet for that round's kit
// → End → scoring. Against a real server with the typed-turn fake voice.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-kit.mjs --env-file <dev key + ROUND_ID> --timeout 30 --out plan/shots/int-web/coding
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, board, click, enterFromTap, go, look, page, placeDesk, recordRound, roundState, save, setupTab, shot, sleep, stage, until, waitState } = L;

const ROUND = process.env.ROUND_ID ?? 'sde.coding.short';
const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab();
// Client side to the round's start page, so the tab keeps its setup (one page load, like a user coming from home).
await page((r) => {
  history.pushState({}, '', `/round/${r}`);
  dispatchEvent(new PopStateEvent('popstate'));
  return true;
}, ROUND);
await until('the start page', () => !!document.querySelector('[data-test="mic-allow"]'));

const tap1 = Date.now();
await click('mic-allow');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
stage('ready for enter', { ms: Date.now() - tap1, round: ROUND });
await enterFromTap('start-round');
await recordRound();
stage('in xr', { kit: await page(() => globalThis.__round.session.round.board_kit), hasBoard: await page(() => globalThis.__round.room.hasBoard), ...(await roundState()) });

const desk = await placeDesk(S);
stage('desk placed', desk);
await waitState(['live'], 120000);
await look(S, -14);
await sleep(1200);
await shot('04-room');
await look(S, -50);
await sleep(1200);
await shot('05-sheet');
stage('greeted', { lines: await page(() => globalThis.__rec.lines), timings: await page(() => globalThis.__round.timings()), board: await board() });

stage('answer 1', await answer('Let me think out loud. I would start with the simplest version that works, say what it costs, and then improve the part that is slowest.'));
await sleep(6000);
await look(S, -50);
await sleep(800);
await shot('06-sheet-after-answer');
stage('board', await board());
await look(S, -50, -28);
await sleep(800);
await shot('07-left-of-sheet');
await look(S, -50, 28);
await sleep(800);
await shot('08-right-of-sheet');

const endAt = Date.now();
await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 60000);
stage('round ended', { ms: Date.now() - endAt, state: (await roundState()).state });
const final = await page(() => ({ timings: globalThis.__round.timings(), rec: globalThis.__rec, session: globalThis.__round.session.session_id, stats: globalThis.__xrApp.stats() }));
final.board = await board();
save('round-kit', { round: ROUND, ...final });
console.log('errors', JSON.stringify(final.rec.errors));
console.log('round kit ok');
