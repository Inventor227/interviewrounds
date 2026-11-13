// End to end in the emulator, against the deployed server with the typed-turn fake voice: a short system design
// round from the first tap to the report page. Home → Start a quick round → Enter the room → touch the desk →
// greeting → three typed answers → two boxes and a connector drawn by hand → a suggestion accepted → End →
// the quick card → the summary → See full report.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-design.mjs --env-file <dev key file> --timeout 40 --out plan/shots/int-web/design
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, board, click, draw, enterFromTap, fail, go, look, page, placeDesk, recordRound, roughBox, roundState, save, setupTab, shot, sleep, stage, tap, until, waitState } = L;

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab({ ghostSettle: 300 });
await shot('01-home');

// Tap 1: the mic, the session and the room load.
const tap1 = Date.now();
await click('try-quick');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
stage('ready for enter', { ms: Date.now() - tap1 });
await shot('02-ready');

// Tap 2: Enter the room.
await enterFromTap('start-round');
await recordRound();
stage('in xr', await roundState());

const desk = await placeDesk(S);
stage('desk placed', desk);
await sleep(1500);
await shot('04-placed');

await waitState(['live'], 120000);
await look(S, -14);
await sleep(1200);
await shot('05-greeting-done');
stage('greeted', { lines: await page(() => globalThis.__rec.lines), timings: await page(() => globalThis.__round.timings()) });

const ANSWERS = [
  'Before I draw anything: I assume about a hundred million new links a day, reads far above writes, and links that never expire. Is that right?',
  'At a high level a client talks to an API service. The service writes the mapping to a key value store and reads go through a cache in front of it.',
  'For the short code I would use a counter based id encoded in base 62, handed out in ranges so that the API servers never collide.',
];
/**
 * Accepts a pending suggestion by pinch. Suggestions wait five minutes in this run (ir_ghost_settle) instead of 4 s,
 * so the scripted hand is in time; the check is that the suggestion is gone and committed right after the pinch.
 */
let pinched = null;
async function pinchGhost(waitRounds) {
  let ghost = null;
  for (let i = 0; i < waitRounds && !ghost; i++) {
    await sleep(1500);
    ghost = await page(() => {
      const d = globalThis.__round.room.debug;
      const g = d.store.board.ghosts[0];
      return g ? { op_id: g.op_id, op: g.op, rect: d.ghostRect(g.op_id), pending: d.store.board.ghosts.length } : null;
    });
  }
  if (!ghost?.rect) return null;
  const before = (await board()).log.filter((e) => e.src === 'scribe' && e.accepted).length;
  await look(S, -52);
  await sleep(600);
  await shot('08-ghost');
  const tapAt = Date.now();
  await tap(ghost.rect.x + ghost.rect.w / 2, ghost.rect.y + ghost.rect.h / 2);
  await sleep(1500);
  const b2 = await board();
  const stillThere = b2.ghosts.some((g) => g.op_id === ghost.op_id);
  const scribe = b2.log.filter((e) => e.src === 'scribe');
  const accepted = scribe.filter((e) => e.accepted).length;
  stage('suggestion accepted by pinch', { ghost, tapMs: Date.now() - tapAt, stillThere, acceptedBefore: before, acceptedNow: accepted, pendingNow: b2.ghosts.length, scribe });
  if (stillThere || accepted <= before) await fail('the pinch did not accept the suggestion', { ghost, b2 });
  await look(S, -52);
  await sleep(800);
  await shot('09-after-ghost');
  return ghost;
}

for (const [i, text] of ANSWERS.entries()) {
  const reply = await answer(text);
  stage(`answer ${i + 1}`, reply);
  // The Scribe suggests after an answer that names parts: take the first suggestion that shows up.
  if (!pinched && i >= 1) pinched = await pinchGhost(6);
}
await look(S, -14);
await sleep(800);
await shot('06-after-answers');

// Draw on the sheet: two boxes and a connector.
await look(S, -52);
await draw(roughBox(8, 10, 12, 7, 3));
await sleep(1000);
await draw(roughBox(38, 10, 12, 7, 5));
await sleep(1000);
let b = await board();
stage('two boxes', b);
if (!b || b.items.filter((i) => i.kind === 'component').length < 2) await fail('the two boxes did not become cards', b);
const [c1, c2] = b.items.filter((i) => i.kind === 'component');
await draw(L.along([[c1.x + c1.w + 0.4, c1.y + c1.h / 2], [c2.x + 1.5, c2.y + c2.h / 2]], 1.5));
await sleep(1200);
b = await board();
stage('connected', b);
await look(S, -52);
await sleep(800);
await shot('07-drawn');
if (!b.edges.length) console.error('WARNING: the connector did not become an edge');

// One more answer about the drawing; if no suggestion was pinched yet, this is the last chance.
const reply4 = await answer('The box on the left is the API service and the one on the right is the key value store. The service reads and writes the store.');
stage('answer 4', reply4);
if (!pinched) pinched = await pinchGhost(20);
if (!pinched) await fail('no suggestion arrived to accept', await board());
await look(S, -5);
await sleep(800);
await shot('10-wall-board');

// End the round (the bar's End needs a held press; the script asks the controller, the same path).
await look(S, -20);
const endAt = Date.now();
await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 60000);
stage('round ended', { ms: Date.now() - endAt });
// At once, with the head already in place: the status card with progress, before the card or the summary comes.
await shot('11-scoring');
stage('after the scoring shot', { state: (await roundState()).state, status: await page(() => globalThis.__xrApp.ui.status.group.visible), summary: await page(() => globalThis.__xrApp.ui.summary.group.visible) });
const card = await until('the quick card or the summary', () => {
  const ui = globalThis.__xrApp?.ui;
  return ui?.summary.group.visible ? { state: globalThis.__round.controller.state } : null;
}, null, 150000, 2000);
stage('card shown', { ms: Date.now() - endAt, ...card });
await sleep(800);
await shot('12-card');
await waitState(['summary'], 240000);
stage('summary', { ms: Date.now() - endAt });
await sleep(1500);
await shot('13-summary');

const final = await page(() => ({ timings: globalThis.__round.timings(), rec: globalThis.__rec, session: globalThis.__round.session.session_id, stats: globalThis.__xrApp.stats() }));
final.board = await board();

// See full report: leaves the headset view and opens the report page.
await page(() => globalThis.__xrApp.ui.emit('report'));
await until('the report page', () => (location.pathname.startsWith('/report/') && document.querySelector('[data-test="page-report"]') ? location.pathname : null), null, 60000);
await sleep(6000);
const report = await page(() => ({ path: location.pathname, text: document.querySelector('main')?.innerText.slice(0, 1500) }));
stage('report page', report);
await L.screenshot('14-report').catch((e) => console.error('report screenshot failed', String(e).slice(0, 300)));

save('round-design', final);
console.log('timings', JSON.stringify(final.timings));
console.log('errors', JSON.stringify(final.rec.errors));
console.log('round design ok');
