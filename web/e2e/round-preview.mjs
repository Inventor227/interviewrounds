// End to end without WebXR (the 2D preview), against the deployed server with the typed-turn fake voice: a short
// system design round on the page, with the sheet drawn on by mouse.
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-preview.mjs --size 1280x720 --env-file <dev key file> --timeout 30 --out plan/shots/int-web/preview
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
copyFileSync(path.join(process.env.EMU_APP_DIR, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, board, click, fail, go, page, play, recordRound, roughBox, roundState, save, setupTab, sleep, stage, until, waitState } = L;

const shot = async (name) => {
  // A capture can fail in the headless browser without anything being wrong with the page: note it and go on.
  try {
    await L.screenshot(name);
    stage(`shot ${name}`);
  } catch (e) {
    stage(`shot ${name} failed`, String(e.message ?? e).slice(0, 200));
  }
};
const scrollTo = (sel) => page((s) => (document.querySelector(s)?.scrollIntoView({ block: 'start' }), true), sel);

/** Draws a stroke through board points (cm) with the mouse on the flat sheet. */
async function mouseDraw(points) {
  return play(`
    const box = await frame.locator('[data-test="session-board"] canvas').boundingBox();
    const k = box.width / 88;
    const pts = ${JSON.stringify(points)}.map(([x, y]) => [box.x + (x + 13) * k, box.y + (y + 1) * k]);
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    for (const [x, y] of pts.slice(1)) { await page.mouse.move(x, y); await page.waitForTimeout(16); }
    await page.waitForTimeout(120);
    await page.mouse.up();
    return { k, box };`, 60000);
}

await waitReady();
await go('/round/sde.system_design.short?preview=1');
await until('the start page', () => !!document.querySelector('[data-test="mic-allow"]'));
await setupTab({ offer: false });
// The page read its voice choice before the dev key was stored: load it again, then stub the mic again.
await go('/round/sde.system_design.short?preview=1');
await until('the start page', () => !!document.querySelector('[data-test="mic-allow"]'));
await setupTab({ offer: false });
await shot('01-start');

const tap1 = Date.now();
await click('mic-allow');
await until('the preview ready', () => !!document.querySelector('[data-test="start-preview"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
stage('ready', { ms: Date.now() - tap1 });
await shot('02-ready');

await click('start-preview');
await recordRound();
await waitState(['live'], 120000);
stage('greeted', { lines: await page(() => globalThis.__rec.lines), timings: await page(() => globalThis.__round.timings()) });
await scrollTo('[data-test="session-stage"]');
await sleep(1500);
await shot('03-room');

stage('answer 1', await answer('I assume about a hundred million new links a day and far more reads than writes. Is that right?'));
stage('answer 2', await answer('A client calls an API service, which writes to a key value store and reads through a cache.'));
await shot('04-after-answers');

await scrollTo('[data-test="session-board"]');
await sleep(500);
await mouseDraw(roughBox(8, 10, 12, 7, 3));
await sleep(600);
await mouseDraw(roughBox(38, 10, 12, 7, 5));
await sleep(600);
let b = await board();
stage('two boxes', b);
if (!b || b.items.filter((i) => i.kind === 'component').length < 2) await fail('the two boxes did not become cards', b);
const [c1, c2] = b.items.filter((i) => i.kind === 'component');
await mouseDraw(L.along([[c1.x + c1.w + 0.4, c1.y + c1.h / 2], [c2.x + 1.5, c2.y + c2.h / 2]], 1));
await sleep(1500);
b = await board();
stage('connected', b);
await shot('05-board');
await scrollTo('[data-test="session-stage"]');
await sleep(800);
await shot('06-room-with-board');

const endAt = Date.now();
await scrollTo('[data-test="session-stage"]');
await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 60000);
// Captures are quick on a flat page: this one catches the status card with its progress bar while the scorecard
// is being written.
await shot('06b-scoring');
stage('scoring shot', { state: (await roundState()).state, status: await page(() => globalThis.__xrApp.ui.status.group.visible), summary: await page(() => globalThis.__xrApp.ui.summary.group.visible) });
await until('the card or the summary', () => (globalThis.__xrApp?.ui.summary.group.visible ? true : null), null, 240000, 2000);
stage('card shown', { ms: Date.now() - endAt, state: (await roundState()).state });
await sleep(800);
await shot('07-card');
await waitState(['summary'], 240000);
await sleep(1500);
await shot('08-summary');

const final = await page(() => ({ timings: globalThis.__round.timings(), rec: globalThis.__rec, session: globalThis.__round.session.session_id }));
final.board = await board();
await click('see-report');
await until('the report page', () => (location.pathname.startsWith('/report/') && document.querySelector('[data-test="page-report"]') ? location.pathname : null), null, 60000);
await sleep(5000);
await shot('09-report');
save('round-preview', final);
console.log('timings', JSON.stringify(final.timings));
console.log('errors', JSON.stringify(final.rec.errors));
console.log('round preview ok');
