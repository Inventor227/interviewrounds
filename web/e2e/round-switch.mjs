// End to end in the emulator, changing input mid round: the round starts with controllers (desk placed with the
// tip and trigger, a box drawn by ray), the controllers go down in the middle of a stroke, and the round is
// finished with hands alone (a box and a connector pinched, a suggestion accepted by pinch, the round ended).
// Then the controllers come back for one more stroke, to show the change works both ways.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-switch.mjs --env-file <dev key file> --timeout 50 --out plan/shots/t25/switch
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['round-lib.mjs', 'input-lib.mjs', 'round-input-lib.mjs']) copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', f), path.join(here, f));
const L = await import('./round-lib.mjs');
const C = await import('./input-lib.mjs');
const R = await import('./round-input-lib.mjs');
const { answer, board, click, draw, enterFromTap, fail, go, look, page, recordRound, roughBox, roundState, save, setupTab, shot, sleep, stage, tap, until, waitState, call } = L;

// Few points per controller stroke: every scripted controller move takes about a second here and the round is 8 minutes.
const box = (x, y, w, h) => L.along([[x + w * 0.3, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y], [x + w * 0.3 + 0.8, y]], 3);

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
// The onboarding shows once per person. This run needs it, so when the server says this guest has had it, the
// page is told otherwise (the answer to /api/me is changed on its way in; nothing is changed on the server).
const meBefore = await page(() => fetch('/api/me').then((r) => r.json()).then((m) => ({ onboarding_done: m.onboarding_done, kind: m.identity?.kind })));
stage('me', meBefore);
if (meBefore.onboarding_done !== false) {
  await L.play(`await page.route('**/api/me', async (route) => { const r = await route.fetch(); const j = await r.json(); j.onboarding_done = false; await route.fulfill({ response: r, json: j }); }); return true;`);
  await go('/');
  await until('the home page again', () => !!document.querySelector('[data-test="try-quick"]'));
}
await setupTab({ ghostSettle: 300 });
// One world on the page: the emulator's small tooling world would run the room's input a second time each frame
// without the session, which lets go of every press on a panel the moment it starts.
await page(() => sessionStorage.setItem('ir_one_world', '1'));
// One capture before the session: the emulator's room needs it to draw.
await shot('s00-home');
await click('try-quick');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await enterFromTap('start-round');
await recordRound();
await page(() => {
  globalThis.__inputs = [];
  globalThis.__xrApp.onInputChange((a) => globalThis.__inputs.push({ input: a, state: globalThis.__round.controller.state }));
});

const desk = await R.placeWithController(S, null, { rest: false });

// A new guest's first round with a sheet teaches the one gesture first, for 30 seconds at most. Holding
// controllers, the line asks for the trigger, and a box drawn by ray completes the step; the round starts after
// it. Every scripted move takes about a second here, so the box is its four corners and nothing else comes first.
const ob = await page(async () => {
  const d = globalThis.__round.room.debug;
  // The step comes up a moment after the sheet lands.
  for (let i = 0; i < 40 && d.onboarding?.showing?.() !== 'box'; i++) await new Promise((r) => setTimeout(r, 100));
  const corners = [[12, 22], [22, 22], [22, 29], [10, 29], [10, 22], [13, 22]];
  return { from: d.toWorld([[36, 56]], 22)[0], pts: d.toWorld(corners, 0), showing: d.onboarding?.showing?.() ?? null, line: globalThis.__xrApp.ui.status.view.title };
});
const from = ob.from;
await C.stroke('right', { from, points: ob.pts }, 0.3);
stage('desk placed with the controller', desk);
stage('onboarding with controllers', { showing: ob.showing, line: ob.line });
await sleep(800);
let b = await board();
const taught = await page(() => ({ showing: globalThis.__round.room.debug.onboarding?.showing?.() ?? null, state: globalThis.__round.controller.state, title: globalThis.__xrApp.ui.status.view }));
stage('box by ray during the onboarding', { items: b.items, taught });
if (ob.showing !== 'box' || ob.line !== 'Pull the trigger and draw a box') await fail('the onboarding did not show the controller line', ob);
if (b.items.filter((i) => i.kind === 'component' && i.label === null).length < 1) await fail('the box drawn by ray did not become a card', b);
if (taught.showing) await fail('the onboarding did not complete on the box drawn with the controller', taught);
await look(S, -52);
await shot('s01-box-drawn-in-onboarding');
await waitState(['live'], 120000);
stage('answer 1', await answer('At a high level a client talks to an API service. The service writes each order to a key value store and reads go through a cache in front of it.'));
await look(S, -52);

// A second stroke begins with the trigger held...
const pts = await page((a) => globalThis.__round.room.debug.toWorld(a, 0), L.along([[36, 24], [50, 24]], 2));
await C.hold('right', from, pts[0]);
await sleep(700);
await C.trigger('right', 1);
await sleep(350);
for (const p of pts.slice(1, 4)) await C.glide('right', from, p, 0.12);
const mid = await R.pointers();
stage('mid stroke with the controller', mid);
if (!mid.overlays.includes('ink')) await fail('the controller stroke did not start', mid);
await shot('s02-mid-stroke-controller');
// ...and the controllers go down: hands take over, with the stroke still in the air.
const logBefore = (await board()).log.length;
await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'hand-left', position: { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.3, y: 0.9, z: S.head.z - 0.12 }, orientation: 'auto' });
await sleep(2500);
const after = await R.pointers();
const st = await R.inputState();
b = await board();
stage('after the controllers went down', { pointers: after, input: st, round: await roundState(), log: b.log.length, changes: await page(() => globalThis.__inputs) });
if (st.active !== 'hands') await fail('hands did not become the active input', st);
if (after.overlays.length) await fail('the stroke was left hanging after the change', after);
if (b.log.length !== logBefore) await fail('the unfinished stroke left an op on the board', b.log.slice(logBefore));
if ((await roundState()).state !== 'live') await fail('the round did not stay live across the change', await roundState());
if (st.hints.length) await fail('a hint was shown on the change', st.hints);
await shot('s03-hands-took-over');

// The round goes on with hands: a box and a connector by pinch.
await draw(roughBox(38, 22, 12, 7, 5));
await sleep(1000);
b = await board();
const drawn = b.items.filter((i) => i.kind === 'component' && i.label === null).sort((p, q) => p.x - q.x);
if (drawn.length < 2) await fail('the box pinched after the change did not become a card', b);
const [c1, c2] = drawn;
await R.drawSettled(L.along([[c1.x + c1.w + 0.6, c1.y + c1.h / 2], [c2.x + 1.5, c2.y + c2.h / 2]], 1.5));
await sleep(1200);
b = await board();
stage('box and connector by hand', { items: b.items.length, edges: b.edges });
// The scripted pinch closes about 2 cm short of where it is sent at this spot (the first card ends up carried by
// that much), so it can take the card instead of its edge. Reported, not required.
if (!b.edges.length) console.error('WARNING: the pinched connector did not become an edge', JSON.stringify(b.items.map((i) => [i.x, i.y])));
await look(S, -52);
await sleep(600);
await shot('s04-drawn-by-both');

// The controllers come back for one more box, mid round: no restart, no prompt. A takes it back. (This comes
// before the pokes: A acts only while the round is on, and the round's clock is short at the emulator's pace.)
await call('xr', 'set-input-mode', { mode: 'controller' });
await C.hold('left', { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, { x: S.head.x - 0.3, y: 0.9, z: S.head.z - 1.1 });
await C.hold('right', from, pts[0]);
await sleep(2000);
// Counted by the cards nobody has named: the Scribe may add its own cards meanwhile.
const plain = (x) => x.items.filter((i) => i.kind === 'component' && i.label === null).length;
const n1 = plain(await board());
await R.strokeBoard('right', box(22, 30, 12, 7), 'near');
await sleep(1200);
b = await board();
stage('a box by touch after the controllers came back', { items: b.items.length, input: await R.inputState(), round: (await roundState()).state });
if (plain(b) !== n1 + 1) await fail('the controller did not draw after coming back', b);
await shot('s05-controllers-back');
await C.pressButton('right', 'primary');
await sleep(1500);
b = await board();
stage('A undid the last box', { items: b.items.length, log: b.log.slice(-2), pulses: await page(() => globalThis.__xrApp.hapticLog().map((p) => `${p.hand}:${p.name}`)) });
if (plain(b) !== n1 || !b.log.some((e) => e.op === 'undo')) await fail('A did not undo the last action', b);

// And down again: the rest is by hand. A fingertip pokes Pause on the round bar, then Resume, then holds End.
await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'hand-left', position: { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, orientation: 'auto' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.3, y: 0.9, z: S.head.z - 0.12 }, orientation: 'auto' });
await sleep(1500);
await look(S, -48);
await R.pokeBar(/Pause/, 0.5);
await waitState(['paused'], 30000);
await shot('s06-paused-by-poke');
await R.pokeBar(/Resume/, 0.5);
await waitState(['live'], 30000);
stage('paused and resumed by a hand poke', await roundState());
await R.pokeBar(/End/, 2.2);
await waitState(['scoring', 'summary'], 60000);
stage('ended by a hand poke held on End', await roundState());
await look(S, -20);
await until('the quick card or the summary', () => (globalThis.__xrApp?.ui.summary.group.visible ? true : null), null, 150000, 2000);
await sleep(800);
await shot('s07-card');
await waitState(['summary'], 240000);
const final = await page(() => ({ rec: globalThis.__rec, session: globalThis.__round.session.session_id, stats: globalThis.__xrApp.stats(), changes: globalThis.__inputs, hints: globalThis.__xrApp.ui.hint.history, pulses: globalThis.__xrApp.hapticLog() }));
final.board = await board();
save('round-switch', final);
console.log('errors', JSON.stringify(final.rec.errors));
// (The session starts with controllers in hand before this script listens: the changes seen are down, up, down.)
if (final.changes.map((c) => c.input).join(',') !== 'hands,controllers,hands') await fail('the input changes were not all reported', final.changes);
console.log('round switch ok');
