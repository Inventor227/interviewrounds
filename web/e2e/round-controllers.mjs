// End to end in the emulator with held controllers, against the deployed server with the typed-turn fake voice: a
// system design round from the first tap to the report page, without a hand in sight. The desk is placed with the
// controller's tip and trigger, two boxes and a connector are drawn (one box by ray, one by touch), a tray card is
// picked by ray and taken back with A, a suggestion is accepted with the trigger, Pause, Resume and End are
// pressed on the round bar by ray, and See full report on the summary card.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-controllers.mjs --env-file <dev key file> --timeout 50 --out plan/shots/t25/controllers
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['round-lib.mjs', 'input-lib.mjs', 'round-input-lib.mjs']) copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', f), path.join(here, f));
const L = await import('./round-lib.mjs');
const C = await import('./input-lib.mjs');
const R = await import('./round-input-lib.mjs');
const { answer, board, click, enterFromTap, fail, go, look, page, recordRound, roundState, save, setupTab, shot, sleep, stage, until, waitState, call } = L;

// The quick round lasts 8 minutes and every scripted controller move takes about a second here, so strokes use
// few points: a box is its four corners with a point every 3 cm.
const box = (x, y, w, h) => L.along([[x + w * 0.3, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y], [x + w * 0.3 + 0.8, y]], 3);

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab({ ghostSettle: 300 });
// One capture before the session: the emulator's room needs it to draw.
await shot('c00-home');
await click('try-quick');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await enterFromTap('start-round');
await recordRound();

// Controllers in hand from the start.
const desk = await R.placeWithController(S, 'c01-prompt');
stage('desk placed with the controller', desk);
if (desk.input !== 'controllers' || desk.hand !== 'right' || Math.abs(desk.deskY - 0.74) > 0.003) await fail('the controller did not place the desk on the desk top', desk);
await sleep(1500);
await shot('c02-placed');
await waitState(['live'], 120000);
stage('greeted', { input: await R.inputState(), lines: await page(() => globalThis.__rec.lines.length) });

// The round clock runs from the first hello and the emulator is slow: one answer that names parts (the Scribe
// then suggests cards), and the captures that can wait are taken while the round is paused.
stage('answer', await answer('At a high level a client talks to an API service. The service writes each order to a key value store and reads go through a cache in front of it.'));
const accepted = await R.acceptGhostByTrigger(S, 14, null);
if (!accepted) await fail('no suggestion arrived to accept', await board());

// Two boxes: the first by ray from a distance, the second with the tip on the sheet.
await look(S, -52);
const from = await R.rayStand();
await R.strokeBoard('right', box(8, 12, 12, 7), 'far', from);
await sleep(800);
let b = await board();
stage('box by ray', b);
if (b.items.filter((i) => i.kind === 'component' && i.label === null).length < 1) await fail('the box drawn by ray did not become a card', b);
await R.strokeBoard('right', box(38, 12, 12, 7), 'near');
await sleep(800);
b = await board();
stage('box by touch', b);
const drawn = b.items.filter((i) => i.kind === 'component' && i.label === null);
if (drawn.length < 2) await fail('the box drawn by touch did not become a card', b);
const [c1, c2] = drawn.sort((p, q) => p.x - q.x);
await R.strokeBoard('right', L.along([[c1.x + c1.w + 0.4, c1.y + c1.h / 2], [c2.x + 1.5, c2.y + c2.h / 2]], 3), 'far', from);
await sleep(1000);
b = await board();
stage('connector by ray', b);
if (!b.edges.length) await fail('the connector drawn by ray did not become an edge', b);

// A tray card picked by ray and dropped on the sheet, then taken back with A.
const tray = await page(() => globalThis.__round.room.debug.tray());
const slot = tray[2];
const n0 = b.items.filter((i) => i.label === null).length;
await R.strokeBoard('right', L.along([[slot.x + slot.w / 2, slot.y + slot.h / 2], [30, 30]], 6), 'far', from);
await sleep(1000);
b = await board();
stage('tray card by ray', { items: b.items.length, last: b.items.at(-1) });
if (b.items.filter((i) => i.label === null).length !== n0 + 1) await fail('the tray card was not placed by ray', b);
await C.pressButton('right', 'primary');
await sleep(1500);
b = await board();
stage('A undid the tray card', { items: b.items.length, log: b.log.slice(-2) });
if (b.items.filter((i) => i.label === null).length !== n0 || !b.log.some((e) => e.op === 'undo')) await fail('A did not undo the last action', b);


// The round bar by ray: Pause, Resume, then End held.
await look(S, -48);
await R.pressBar('right', /Pause/, null);
await waitState(['paused'], 30000);
stage('paused by ray', await roundState());
// Paused: the clock waits. One capture of what was drawn, with the ray and its dot on the sheet (kept short: a
// long pause lets the voices go, and coming back from that is another task's test).
await look(S, -52);
await R.aim('right', from, [30, 33]);
await sleep(1000);
await shot('c08-drawn-with-ray-and-dot');
stage('ray on the sheet', (await R.pointers()).over);
await look(S, -48);
await R.pressBar('right', /Resume/, null);
await waitState(['live'], 30000);
stage('resumed by ray', await roundState());
const endAt = Date.now();
await R.holdBar('right', /End/, 1.9);
await waitState(['scoring', 'summary'], 60000);
stage('ended by holding End with the trigger', { ms: Date.now() - endAt });
await look(S, -20);
await until('the quick card or the summary', () => (globalThis.__xrApp?.ui.summary.group.visible ? true : null), null, 150000, 2000);
await sleep(800);
await shot('c10-card');
await waitState(['summary'], 240000);
await sleep(1500);

const final = await page(() => ({ timings: globalThis.__round.timings(), rec: globalThis.__rec, session: globalThis.__round.session.session_id, stats: globalThis.__xrApp.stats(), pulses: globalThis.__xrApp.hapticLog(), hints: globalThis.__xrApp.ui.hint.history }));
final.board = await board();
final.input = await R.inputState();

// See full report, by ray on the summary card.
await R.pressCard('right', S, 'summary', /report/i, 'c11-ray-on-report');
await until('the report page', () => (location.pathname.startsWith('/report/') && document.querySelector('[data-test="page-report"]') ? location.pathname : null), null, 60000);
await sleep(5000);
stage('report page', await page(() => ({ path: location.pathname, text: document.querySelector('main')?.innerText.slice(0, 600) })));
await L.screenshot('c12-report').catch((e) => console.error('report screenshot failed', String(e).slice(0, 300)));

save('round-controllers', final);
console.log('errors', JSON.stringify(final.rec.errors));
if (final.hints.some((h) => /controller/i.test(h.line))) await fail('a hint mentioned controllers', final.hints);
console.log('round controllers ok');
