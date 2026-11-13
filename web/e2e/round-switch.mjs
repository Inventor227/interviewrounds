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

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab({ ghostSettle: 300 });
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

const desk = await R.placeWithController(S, null);
stage('desk placed with the controller', desk);
await waitState(['live'], 120000);
stage('answer 1', await answer('At a high level a client talks to an API service. The service writes the mapping to a key value store and reads go through a cache in front of it.'));

// One box by ray with the controller.
await look(S, -52);
const from = await R.rayStand();
await R.strokeBoard('right', roughBox(8, 10, 12, 7, 3), 'far', from);
await sleep(1000);
let b = await board();
if (b.items.filter((i) => i.kind === 'component' && i.label === null).length < 1) await fail('the box drawn by ray did not become a card', b);
stage('box by ray', { items: b.items.length });

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
await shot('s01-mid-stroke-controller');
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
await shot('s02-hands-took-over');

// The round goes on with hands: a box and a connector by pinch.
await draw(roughBox(38, 10, 12, 7, 5));
await sleep(1000);
b = await board();
const drawn = b.items.filter((i) => i.kind === 'component' && i.label === null).sort((p, q) => p.x - q.x);
if (drawn.length < 2) await fail('the box pinched after the change did not become a card', b);
const [c1, c2] = drawn;
await draw(L.along([[c1.x + c1.w + 0.4, c1.y + c1.h / 2], [c2.x + 1.5, c2.y + c2.h / 2]], 1.5));
await sleep(1200);
b = await board();
stage('box and connector by hand', { items: b.items.length, edges: b.edges });
if (!b.edges.length) await fail('the connector pinched after the change did not become an edge', b);
await look(S, -52);
await sleep(600);
await shot('s03-drawn-by-both');

// A hand pokes Pause on the round bar (direct touch), then Resume. Recorded, not required: the emulator renders a
// few frames a second, and a poke can fall between two of them.
{
  const poke = async (re) => {
    const list = await R.clickables('roundBar');
    const at = list.find((x) => re.test(x.label))?.at;
    if (!at) return false;
    // Along the bar's normal (it leans 35 degrees up from the desk, facing the user).
    const off = (d) => ({ x: at.x, y: at.y + 0.819 * d, z: at.z + 0.574 * d });
    await C.xr('run-sequence', {
      device: 'hand-right',
      steps: [
        { label: 'above', position: off(0.06), anchor: 'index-tip', duration: 0.7, poseId: 'point' },
        { label: 'press', position: off(-0.004), anchor: 'index-tip', duration: 0.5 },
        { label: 'hold', duration: 1.2 },
        { label: 'back', position: off(0.08), anchor: 'index-tip', duration: 0.6 },
      ],
      body: 'auto',
      gaze: 'fixed',
      idleHand: 'keep',
    }).catch((e) => console.log('poke failed', String(e).slice(0, 300)));
    await sleep(1500);
    return true;
  };
  await look(S, -48);
  await poke(/Pause/);
  const paused = (await roundState()).state === 'paused';
  if (paused) await shot('s02b-paused-by-poke');
  let resumed = null;
  if (paused) {
    await poke(/Resume/);
    resumed = (await roundState()).state === 'live';
    if (!resumed) {
      await page(() => globalThis.__round.controller.resume());
      await waitState(['live'], 30000);
    }
  }
  stage('hand poke on the round bar', { paused, resumed });
  await call('xr', 'set-hand-pose', { device: 'hand-right', poseId: 'default' });
  await look(S, -52);
}

// A suggestion accepted by pinch, if one is waiting or comes with the next answer.
stage('answer 2', await answer('The box on the left is the API service and the one on the right is the key value store. The service reads and writes the store.'));
let ghost = null;
for (let i = 0; i < 12 && !ghost; i++) {
  await sleep(1500);
  ghost = await page(() => {
    const d = globalThis.__round.room.debug;
    const g = d.store.board.ghosts[0];
    return g ? { op_id: g.op_id, rect: d.ghostRect(g.op_id) } : null;
  });
}
if (ghost?.rect) {
  await look(S, -52);
  await tap(ghost.rect.x + ghost.rect.w / 2, ghost.rect.y + ghost.rect.h / 2);
  await sleep(1500);
  const still = await page((id) => globalThis.__round.room.debug.store.board.ghosts.some((g) => g.op_id === id), ghost.op_id);
  stage('suggestion accepted by pinch', { ghost, still });
  if (still) await fail('the pinch did not accept the suggestion after the change', ghost);
} else stage('no suggestion came in time (not a failure of this run)');

// The controllers come back for one more box, mid round: no restart, no prompt.
await call('xr', 'set-input-mode', { mode: 'controller' });
await C.hold('left', { x: S.head.x - 0.3, y: 0.95, z: S.head.z - 0.1 }, { x: S.head.x - 0.3, y: 0.9, z: S.head.z - 1.1 });
await C.hold('right', from, pts[0]);
await sleep(2000);
const n1 = (await board()).items.length;
await R.strokeBoard('right', roughBox(22, 26, 12, 7, 9), 'near');
await sleep(1200);
b = await board();
stage('a box by touch after the controllers came back', { items: b.items.length, input: await R.inputState(), changes: await page(() => globalThis.__inputs) });
if (b.items.length !== n1 + 1) await fail('the controller did not draw after coming back', b);
await shot('s04-controllers-back');

// And down again: the round is ended with hands (as in the hands run, through the round's own End).
await call('xr', 'set-input-mode', { mode: 'hand' });
await call('xr', 'set-transform', { device: 'hand-right', position: { x: S.head.x + 0.3, y: 0.9, z: S.head.z - 0.12 }, orientation: 'auto' });
await sleep(1500);
await look(S, -20);
await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 60000);
await until('the quick card or the summary', () => (globalThis.__xrApp?.ui.summary.group.visible ? true : null), null, 150000, 2000);
await sleep(800);
await shot('s05-card');
await waitState(['summary'], 240000);
const final = await page(() => ({ rec: globalThis.__rec, session: globalThis.__round.session.session_id, stats: globalThis.__xrApp.stats(), changes: globalThis.__inputs, hints: globalThis.__xrApp.ui.hint.history, pulses: globalThis.__xrApp.hapticLog() }));
final.board = await board();
save('round-switch', final);
console.log('errors', JSON.stringify(final.rec.errors));
if (final.changes.map((c) => c.input).join(',') !== 'controllers,hands,controllers,hands') await fail('the input changes were not all reported', final.changes);
console.log('round switch ok');
