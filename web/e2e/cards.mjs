// Every interruption card in the room, for layout: the round is brought live (fake voice), then each card of
// session/notices.ts is put up through the round UI (staged: the real flows are in round-pause.mjs and the unit
// tests), plus the brief card with the longest question in content and the hints.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/cards.mjs --env-file <env file> --timeout 40 --out plan/shots/t21/cards
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { click, enterFromTap, go, look, page, placeDesk, recordRound, save, setupTab, shot, sleep, stage, until, waitState } = L;

const S = L.SETUPS[process.env.EMU_ROOM ?? 'home_office'] ?? L.SETUPS.home_office;
const KINDS = (process.env.CARDS ?? 'paused,welcome_back,reconnecting,degraded,socket,lost,scoring_slow,ended_paused').split(',');

await waitReady();
await go('/');
await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
await setupTab();
// As in the other round runs: a capture of the page before the room exists (the managed browser draws its first frames for it).
await shot('00-home');
await click('try-quick');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
await shot('00-ready');
await enterFromTap('start-round');
await recordRound();
await placeDesk(S, '00-placing');
await waitState(['live'], 120000);
// Hold the round so nothing moves under the shots (a real pause; the cards below are then set by hand).
await page(() => globalThis.__round.controller.pause('user'));
await look(S, -32);
await sleep(1000);

const out = {};
for (const kind of KINDS) {
  out[kind] = await page((k) => {
    const ui = globalThis.__xrApp.ui;
    ui.setNotice(k);
    return ui.status.view;
  }, kind);
  await sleep(700);
  await shot(`card-${kind}`);
  stage(kind, out[kind]);
}
await page(() => globalThis.__xrApp.ui.setNotice('paused'));

// The brief card with the longest question and four two-row lines; the hints.
await page(() => {
  const app = globalThis.__xrApp;
  const ui = app.ui;
  ui.setNotice(null);
  ui.setRoundState({ status: 'live', elapsed_s: 125, total_s: 480, muted: false, brief: { question: 'Conflict between design and engineering', lines: ['Print unless the same text printed in the last 10 seconds', 'Sixty thousand seats, three million fans at ten in the morning', 'Reads far above writes, links never expire', 'Say what you would measure first and why it matters'] } });
  ui.layoutHint(app.headPose());
  ui.showHint("Can't see your hands. Raise them into view.", performance.now(), 120000);
});
await look(S, -20);
await sleep(900);
await shot('brief-longest-and-hands-lost');
await page(() => {
  const app = globalThis.__xrApp;
  app.ui.layoutHint(app.headPose());
  app.ui.showHint("Can't see your hands. Raise them into view.", performance.now(), 120000);
});
await sleep(700);
await shot('hint-controllers');
save('cards', out);
await page(() => globalThis.__round.controller.end());
console.log('cards ok');
