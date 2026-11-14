// End to end for every Tier 1 round in short length, in the emulator against the deployed server with the typed-turn
// fake voice: start → place → four typed answers (more than a minute of speech, so the round is scored) → in board
// rounds two boxes and a connector drawn by hand and a suggestion accepted by pinch → End → the quick card → the
// summary → the report page, whose JSON is saved for the report.v1 check. Every spoken line is checked for tool names,
// the hold line and "the user" (PM rounds: "the candidate"; there "the user" is a product's user).
//   ROUND_ID=<round id> (meeting.short runs the investor pitch with its two attendees)  INPUT=hands|controllers
//   plan/ops-tools/emu.sh <worktree> <worktree>/web/e2e/round-tier1.mjs --env-file <dev key + ROUND_ID> --timeout 40 \
//     --out plan/shots/t22/<round>
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitReady } from './emu-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.EMU_APP_DIR;
copyFileSync(path.join(APP, 'e2e', 'round-lib.mjs'), path.join(here, 'round-lib.mjs'));
const L = await import('./round-lib.mjs');
const { answer, board, click, draw, enterFromTap, go, look, page, placeDesk, recordRound, roughBox, roundState, setupTab, shot, sleep, stage, tap, until, waitState } = L;

const ROUND = process.env.ROUND_ID ?? 'sde.system_design.short';
const INPUT = process.env.INPUT ?? 'hands';
const MEETING = ROUND.startsWith('meeting.');
const PM = ROUND.startsWith('pm.');
const S = L.SETUPS[process.env.EMU_ROOM ?? (MEETING ? 'conference_room' : 'home_office')] ?? L.SETUPS.home_office;
const ANSWERS = JSON.parse(readFileSync(path.join(APP, 'e2e', 'tier1-lines.json'), 'utf8'))[ROUND];
if (!ANSWERS) throw new Error(`no answers for ${ROUND}`);
const result = { round: ROUND, input: INPUT, checks: {}, problems: [], warnings: [] };
const problem = (what, detail) => {
  result.problems.push({ what, detail });
  stage(`PROBLEM ${what}`, detail);
};

await waitReady();
if (MEETING) {
  await go('/meeting/new?template=investor_pitch');
  await until('the meeting setup', () => !!document.querySelector('[data-test="prepare"]'));
  await setupTab({ ghostSettle: 300 });
  await shot('01-setup');
  const prep = Date.now();
  await click('prepare');
  await until('the prepared meeting', () => !!document.querySelector('[data-test="prepared"]'), null, 120000);
  stage('meeting prepared', { ms: Date.now() - prep });
  await shot('02-prepared');
} else {
  await go('/');
  await until('the home page', () => !!document.querySelector('[data-test="try-quick"]'));
  await setupTab({ ghostSettle: 300 });
  // Client side to the round's start page, so the tab keeps its setup.
  await page((r) => {
    history.pushState({}, '', `/round/${r}`);
    dispatchEvent(new PopStateEvent('popstate'));
    return true;
  }, ROUND);
  await until('the start page', () => !!document.querySelector('[data-test="mic-allow"]'));
  await shot('01-start');
}
// Panels pressed by the script need the one-world flag (emulator tooling).
await page(() => (sessionStorage.setItem('ir_one_world', '1'), true));

const tap1 = Date.now();
await click('mic-allow');
await until('the round ready for Enter', () => !!document.querySelector('[data-test="start-round"]:not([disabled])') && !!globalThis.__xrApp, null, 150000);
stage('ready for enter', { ms: Date.now() - tap1 });
await shot('02-ready');
await enterFromTap('start-round');
await recordRound();
const kit = await page(() => globalThis.__round.session.round.board_kit);
stage('in xr', { kit, ...(await roundState()) });
if (INPUT === 'controllers') await L.call('xr', 'set-input-mode', { mode: 'controller' }).catch((e) => problem('controller mode', String(e).slice(0, 200)));
const desk = await placeDesk(S);
stage('desk placed', desk);
await waitState(['live'], 120000);
await look(S, MEETING ? -12 : -14, MEETING ? 10 : 0);
await sleep(1200);
await shot('04-greeted');
stage('greeted', { lines: await page(() => globalThis.__rec.lines), timings: await page(() => globalThis.__round.timings()) });

/** Accepts the first suggestion that shows up, by pinch (the script's hand) on the ghost. */
let pinched = null;
async function pinchGhost(waitRounds) {
  let ghost = null;
  for (let i = 0; i < waitRounds && !ghost; i++) {
    await sleep(1500);
    ghost = await page(() => {
      const d = globalThis.__round.room.debug;
      const g = d?.store.board.ghosts[0];
      return g ? { op_id: g.op_id, op: g.op, rect: d.ghostRect(g.op_id) } : null;
    });
  }
  if (!ghost?.rect) return null;
  const before = (await board()).log.filter((e) => e.src === 'scribe' && e.accepted).length;
  await look(S, -52);
  await sleep(600);
  await shot('08-ghost');
  await tap(ghost.rect.x + ghost.rect.w / 2, ghost.rect.y + ghost.rect.h / 2);
  await sleep(1500);
  const b = await board();
  const stillThere = b.ghosts.some((g) => g.op_id === ghost.op_id);
  const accepted = b.log.filter((e) => e.src === 'scribe' && e.accepted).length;
  stage('suggestion pinched', { ghost, stillThere, acceptedBefore: before, acceptedNow: accepted });
  if (accepted <= before) problem('the pinch did not accept the suggestion', { ghost });
  else if (stillThere) result.warnings.push('the accepted suggestion still listed as a ghost right after the pinch');
  return ghost;
}

/** Two boxes and a connector, drawn by hand on the sheet (the kit decides what a box becomes: a component, a class). */
async function drawTwoBoxes() {
  await look(S, -52);
  await draw(roughBox(8, 10, 12, 7, 3));
  await sleep(1000);
  await draw(roughBox(38, 10, 12, 7, 5));
  await sleep(1000);
  let b = await board();
  const drawn = b.items.filter((x) => x.kind !== 'ink' && x.label === null);
  stage('two boxes', { items: b.items.length, drawn: drawn.length, kinds: b.items.map((x) => x.kind) });
  if (kit === 'pm') {
    // The PM sheet is columns of sticky notes with no connectors: a drawn box becomes a sticky in its column.
    if (!drawn.some((x) => x.kind === 'sticky')) problem('no drawn box became a sticky note', { kinds: b.items.map((x) => x.kind) });
    await sleep(600);
    await shot('07-drawn');
    return;
  }
  if (drawn.length >= 2) {
    const [c1, c2] = drawn;
    await draw(L.along([[c1.x + c1.w + 0.4, c1.y + c1.h / 2], [c2.x + 1.5, c2.y + c2.h / 2]], 1.5));
    await sleep(1200);
    b = await board();
    stage('connected', { edges: b.edges.length });
    // The emulator's scripted pinch closes about 2 cm short of where it is sent, so it can take a card instead of
    // its edge (the same is reported, not required, in round-design.mjs). Reported, not a failure.
    if (!b.edges.length) {
      result.warnings.push('the scripted connector did not become an edge');
      stage('WARNING the scripted connector did not become an edge', { items: b.items.map((i) => [i.x, i.y, i.w, i.h]) });
    }
  } else {
    problem('the two drawn boxes did not become cards', { kinds: b.items.map((x) => x.kind) });
  }
  await sleep(600);
  await shot('07-drawn');
}

const BOARD = kit && kit !== 'coding' && !MEETING;
const DRAWING = JSON.parse(readFileSync(path.join(APP, 'e2e', 'tier1-lines.json'), 'utf8'))[`${ROUND}.drawing`] ?? null;
const replies = [];
// Board rounds draw after the second answer, so the answers after it (and one about the drawing) give the Scribe
// something to suggest for the drawn cards.
const turns = [...ANSWERS.map((t) => ({ text: t })), ...(BOARD && DRAWING ? [{ text: DRAWING, drawing: true }] : [])];
for (const [i, turn] of turns.entries()) {
  const st = await roundState();
  if (!st || st.state !== 'live') {
    // A short round can run out of time in the slow emulator; three answers (over a minute of speech) still score.
    if (i < 3) problem('the round ended before three answers', { answered: i, state: st?.state });
    else result.warnings.push(`the round's own clock ended it after ${i} answers`);
    break;
  }
  const reply = await answer(turn.text, 120000);
  replies.push(reply);
  stage(`answer ${i + 1}`, reply);
  if (BOARD && i === 1) await drawTwoBoxes();
  if (BOARD && !pinched && i >= 2) pinched = await pinchGhost(turn.drawing ? 12 : 4);
  if (MEETING && i === 2) {
    const fl = await until('the floor to move', () => {
      const c = globalThis.__round.controller;
      return c.floor !== globalThis.__round.session.floor ? c.floor : null;
    }, null, 30000, 2000).catch(() => null);
    stage('hand-over', { floor: fl });
    if (!fl) problem('no hand-over after asking Tom', null);
    await look(S, -12, 10);
    await sleep(800);
    await shot('06-hand-over');
  }
}

if (kit === 'coding') {
  // The coding sheet is the code panel, the approach and the complexity slots: hand-drawn boxes stay ink by design,
  // and the Scribe fills the slots itself. Recorded, not drawn.
  const b = await board();
  result.coding_board = { items: b.items.map((x) => x.kind), scribe: b.log.filter((e) => e.src === 'scribe').map((e) => `${e.op}:${e.accepted}`) };
  stage('coding sheet', result.coding_board);
  await look(S, -52);
  await sleep(800);
  await shot('07-sheet');
} else if (BOARD) {
  const stillLive = (await roundState())?.state === 'live';
  if (!pinched && stillLive) pinched = await pinchGhost(8);
  if (!pinched) {
    if (stillLive) problem('no suggestion arrived to accept', null);
    else result.warnings.push('the round ended before a suggestion could be accepted');
  }
  await look(S, -5);
  await sleep(800);
  await shot('09-wall-board');
}

// Spoken lines: no tool names, no hold line, the candidate is "you".
const lines = await page(() => globalThis.__rec.lines.filter((l) => l.role === 'agent').map((l) => ({ who: l.who, text: l.text })));
const TOOLS = /\b(show_question|next_phase|point_at|give_hint|hand_over|end_round)\b/i;
const third = PM ? /\bthe candidate\b/i : /\bthe (user|candidate)\b/i;
result.checks.agent_lines = lines.length;
result.checks.tool_names = lines.filter((l) => TOOLS.test(l.text));
result.checks.hold_lines = lines.filter((l) => /sorry, give me a second/i.test(l.text));
result.checks.third_person = lines.filter((l) => third.test(l.text));
for (const k of ['tool_names', 'hold_lines', 'third_person']) if (result.checks[k].length) problem(`spoken ${k}`, result.checks[k]);

// End, the quick card, the summary.
await look(S, -20);
const endAt = Date.now();
await page(() => globalThis.__round.controller.end());
await waitState(['scoring', 'summary'], 60000);
await shot('10-scoring');
const card = await until('the quick card or the summary', () => (globalThis.__xrApp?.ui.summary.group.visible ? globalThis.__round.controller.state : null), null, 180000, 2000);
stage('card shown', { ms: Date.now() - endAt, state: card });
await sleep(800);
await shot('11-card');
await waitState(['summary'], 240000);
stage('summary', { ms: Date.now() - endAt });
await sleep(1200);
await shot('12-summary');

const final = await page(() => ({ timings: globalThis.__round.timings(), rec: globalThis.__rec, session: globalThis.__round.session.session_id, stats: globalThis.__xrApp.stats() }));
final.board = kit ? await board() : null;

// The report page, and its JSON for the schema check.
await page(() => globalThis.__xrApp.ui.emit('report'));
await until('the report page', () => (location.pathname.startsWith('/report/') && document.querySelector('[data-test="page-report"]') ? location.pathname : null), null, 60000);
const rendered = await until('the report rendered', () => (document.querySelector('[data-test="verdict"]') ? document.querySelector('main')?.innerText.slice(0, 600) : null), null, 240000, 3000).catch(() => null);
if (!rendered) problem('the report page did not render a verdict', null);
await sleep(1500);
await L.screenshot('13-report').catch(() => undefined);
const report = await page(async (sid) => {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/report`, { credentials: 'include' });
  return { status: r.status, body: r.ok ? await r.json() : null };
}, final.session);
writeFileSync(path.join(process.env.EMU_SHOTS, 'report.json'), JSON.stringify(report.body, null, 2));
if (report.status !== 200) problem('report fetch', report.status);

result.session = final.session;
result.timings = final.timings;
result.replies = replies;
result.ok = result.problems.length === 0;
L.save('round-tier1', { ...result, final });
console.log('problems', JSON.stringify(result.problems), 'warnings', JSON.stringify(result.warnings));
console.log(result.ok ? 'round tier1 ok' : 'round tier1 FAILED');
process.exit(result.ok ? 0 : 1);
