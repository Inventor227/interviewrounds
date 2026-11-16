// End to end for every Tier 1 round in short length, in the emulator against the deployed server with the typed-turn
// fake voice: start → place → four typed answers (more than a minute of speech, so the round is scored) → in board
// rounds two boxes and a connector drawn by hand and a suggestion accepted by pinch → End → the quick card → the
// summary → the report page, whose JSON is saved for the report.v1 check. Every spoken line is checked for tool names,
// the hold line and "the user" (PM rounds: "the candidate"; there "the user" is a product's user).
//   ROUND_ID=<round id> (meeting.short runs the investor pitch with its two attendees)  INPUT=hands|controllers
//   Emulator run (see README.md): env DEV_KEY, IR_API_ORIGIN and ROUND_ID; allow up to 40 minutes.
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
// A meeting's clock and its silence checks run on: its first answer goes out before the slow capture.
if (!MEETING) {
  await look(S, -14, 0);
  await sleep(1200);
  await shot('04-greeted');
}
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
    // From the first card's edge to the second card. The start band is narrow (the card's 0.8 cm rim to 1.4 cm
    // outside), so the script first measures where its pinch lands on empty sheet just below the card, then aims with
    // that offset taken off (see pinchOffset), and rests over the start before it pinches (see draw).
    const from = [c1.x + c1.w + 0.4, c1.y + c1.h / 2];
    const to = [c2.x + 1.5, c2.y + c2.h / 2];
    const offset = (await L.pinchOffset(from[0], Math.min(c1.y + c1.h + 4, 36))) ?? [0, 0];
    const aim = (p) => [p[0] - offset[0], p[1] - offset[1]];
    const downsBefore = (await page(() => globalThis.__round.room.debug.pinches?.().length ?? 0)) ?? 0;
    await draw(L.along([aim(from), aim(to)], 1.5), 0.1, { rest: 1.5, hold: 0.5, end: 0.8 });
    await sleep(1200);
    b = await board();
    const down = await page((i) => globalThis.__round.room.debug.pinches?.()[i] ?? null, downsBefore);
    // Where the pinch went down against the card's right edge: the rim (0.8 cm inside) to 1.4 cm outside draws.
    result.connector = { from, offset, down, start_vs_edge_cm: down ? Math.round((down.x_cm - (c1.x + c1.w)) * 100) / 100 : null, edges: b.edges.length };
    stage('connected', result.connector);
    if (!b.edges.length) problem('the line from one card to the other did not connect them', { ...result.connector, items: b.items.map((i) => [i.id, i.x, i.y, i.w, i.h]) });
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
  if (MEETING && i === 0) {
    await look(S, -12, 10);
    await sleep(800);
    await shot('04-greeted');
  }
  if (MEETING && i === 1) {
    // round-lib's until ends the run on a timeout: a poll of its own, with one more ask if the floor stays.
    const floorNow = () => page(() => {
      const c = globalThis.__round.controller;
      return c.floor !== globalThis.__round.session.floor ? c.floor : null;
    }).catch(() => null);
    let fl = null;
    for (let k = 0; k < 15 && !fl; k++) {
      await sleep(2000);
      fl = await floorNow();
    }
    if (!fl && (await roundState())?.state === 'live') {
      stage('ask Tom once more', await answer('Tom, I would really like to hear from you now. What would stop you from investing?', 120000));
      for (let k = 0; k < 15 && !fl; k++) {
        await sleep(2000);
        fl = await floorNow();
      }
    }
    stage('hand-over', { floor: fl });
    if (!fl) problem('no hand-over after asking Tom twice', null);
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

// Spoken lines: no tool names, no hold line, the candidate is "you". Checked now and again after the summary, so
// the closing line (said after End, the one most likely to name a tool or the candidate) is checked too.
const TOOLS = /\b(show_question|next_phase|point_at|give_hint|hand_over|end_round)\b/i;
const third = PM ? /\bthe candidate\b/i : /\bthe (user|candidate)\b/i;
const agentLines = (rec) => rec.lines.filter((l) => l.role === 'agent').map((l) => ({ key: l.segmentId, who: l.who, text: l.text }));
const checkLines = (lines) => {
  const found = {
    tool_names: lines.filter((l) => TOOLS.test(l.text)),
    hold_lines: lines.filter((l) => /sorry, give me a second/i.test(l.text)),
    third_person: lines.filter((l) => third.test(l.text)),
  };
  Object.assign(result.checks, found, { agent_lines: lines.length });
  return found;
};
const lines = agentLines(await page(() => globalThis.__rec));
for (const [k, v] of Object.entries(checkLines(lines))) if (v.length) problem(`spoken ${k}`, v);

// End, the quick card, the summary.
await look(S, -20);
const endAt = Date.now();
// The round may have closed itself first (its own clock, or the interviewer's end): then its goodbye was already
// said before End, and End only finishes what is under way.
const stateAtEnd = await page(() => globalThis.__round.controller.state);
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

// The same checks over every line of the round, the goodbye included. Lines are told apart by their key
// (panelist, voice, segment), so a line first heard after End is one whose key was not there before.
const everyLine = agentLines(final.rec);
const beforeKeys = new Set(lines.map((l) => l.key));
result.checks.closing_lines = everyLine.filter((l) => !beforeKeys.has(l.key));
result.checks.state_at_end = stateAtEnd;
for (const [k, v] of Object.entries(checkLines(everyLine))) {
  const late = v.filter((l) => !beforeKeys.has(l.key));
  if (late.length) problem(`spoken ${k} after End`, late);
}
if (!result.checks.closing_lines.length) {
  if (stateAtEnd === 'live') result.warnings.push('no closing line was heard after End');
  else result.warnings.push(`the round had closed itself (${stateAtEnd}) before End: its goodbye came before it`);
}

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
