// End to end in the emulator, against the deployed server with the typed-turn fake voice: a two person meeting
// rehearsal (the investor pitch). Meeting setup → Get the room ready → Enter the meeting room → touch the table →
// the chair opens → two typed answers → a question to the other attendee (hand-over) → End.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-meeting.mjs --room conference_room --env-file <dev key file> --timeout 40 --out plan/shots/int-web/meeting
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, click, enterFromTap, go, look, page, placeDesk, recordRound, roundState, save, setupTab, shot, sleep, stage, until, waitState } = L;

const S = L.SETUPS[process.env.EMU_ROOM ?? 'conference_room'] ?? L.SETUPS.conference_room;

await waitReady();
await go('/meeting/new?template=investor_pitch');
await until('the meeting setup', () => !!document.querySelector('[data-test="prepare"]'));
await setupTab();
await shot('01-setup');

const prep = Date.now();
await click('prepare');
await until('the prepared meeting', () => !!document.querySelector('[data-test="prepared"]'), null, 120000);
stage('meeting prepared', { ms: Date.now() - prep, people: await page(() => [...document.querySelectorAll('[data-test="plan-attendee"]')].map((e) => e.innerText.split('\n')[0])) });
await shot('02-prepared');

const tap1 = Date.now();
await click('mic-allow');
await until('the room ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
stage('ready for enter', { ms: Date.now() - tap1 });

await enterFromTap('start-round');
await recordRound();
const panel = await page(() => globalThis.__round.session.panel.map((p) => ({ id: p.panelist_id, name: p.display_name, avatar: p.avatar_id, seat: p.seat, voice: p.voice.transport })));
stage('in xr', { panel, mode: await page(() => globalThis.__round.session.panel_mode), ...(await roundState()) });

const desk = await placeDesk(S);
stage('desk placed', desk);
await waitState(['live'], 120000);
await look(S, -12, 10);
await sleep(1500);
await shot('04-room');
stage('opened', { lines: await page(() => globalThis.__rec.lines), timings: await page(() => globalThis.__round.timings()), seats: await page(() => globalThis.__xrApp.room.seatPoses()) });

const floor0 = (await roundState()).floor;
const other = panel.find((p) => p.id !== floor0);
stage('answer 1', await answer('Thanks for making the time. We help mid sized clinics cut no shows with reminders that patients actually answer, and we are raising two million to grow sales.'));
stage('answer 2', await answer('Revenue is forty thousand a month, growing twelve percent month over month, with churn under two percent.'));
await look(S, -12, 10);
await sleep(800);
await shot('05-after-answers');
await look(S, -50);
await sleep(800);
await shot('05b-sheet');
stage('meeting sheet', { kit: await page(() => globalThis.__round.session.round.board_kit), hasBoard: await page(() => globalThis.__round.room.hasBoard), board: await L.board() });

// Settle the open questions, then ask the other attendee directly until the server hands the floor over.
const name = other?.name ?? 'the other person';
const ASKS = [
  `To be exact: we are raising one point five million, revenue is sixteen thousand a month and growth is fifteen percent. That is my full answer. ${name}, you have been quiet. What is your biggest concern with this round?`,
  `${name}, I would really like to hear from you now. What would stop you from investing?`,
  `I have answered that, so I will pause here and ask ${name} to speak. ${name}, please go ahead.`,
];
let floor1 = floor0;
let reply = null;
let asks = 0;
const live = async () => (await roundState()).state === 'live';
for (const ask of ASKS) {
  if (!(await live())) break; // a short meeting can run out of time by itself in the slow emulator
  asks++;
  reply = await answer(ask, 120000);
  for (let i = 0; i < 6 && floor1 === floor0; i++) {
    await sleep(2500);
    floor1 = (await roundState()).floor;
  }
  if (floor1 !== floor0) break;
}
stage('hand-over', { asked: name, asks, from: floor0, to: floor1, handedOver: floor1 !== floor0, reply });
if (floor1 === floor0) console.error('WARNING: the floor did not move');
else if (await live()) {
  await sleep(6000); // the new attendee's opening line
  stage('after hand-over', { lines: await page(() => globalThis.__rec.lines.slice(-3)) });
  stage('answer to the new floor', await answer('That is fair. Our pipeline covers the next two quarters, and I can share the signed letters of intent.'));
}
await look(S, -12, 10);
await sleep(800);
await shot('06-after-hand-over');

const endAt = Date.now();
if (await live()) await page(() => globalThis.__round.controller.end());
else stage('the round had already ended by itself', await roundState());
await waitState(['scoring', 'summary'], 60000);
stage('round ended', { ms: Date.now() - endAt });
await look(S, -20);
await sleep(1000);
await shot('07-scoring');
await until('the card or the summary', () => (globalThis.__xrApp?.ui.summary.group.visible ? true : null), null, 240000, 2000);
stage('card shown', { ms: Date.now() - endAt, state: (await roundState()).state });
await sleep(800);
await shot('08-card');

const final = await page(() => ({ timings: globalThis.__round.timings(), rec: globalThis.__rec, session: globalThis.__round.session.session_id, stats: globalThis.__xrApp.stats() }));
save('round-meeting', { ...final, panel });
console.log('timings', JSON.stringify(final.timings));
console.log('errors', JSON.stringify(final.rec.errors));
console.log('round meeting ok');
