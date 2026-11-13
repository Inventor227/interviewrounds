import { describe, expect, it } from 'vitest';
import type { Board, BoardCode, BoardOp } from '../../shared/types';
import { BoardInput } from '../input';
import { emptyBoard } from '../model';
import { applyOp, BoardStore } from '../ops';
import { checkParsons, parsons, parsonsAnswer } from '../parsons';
import { FakeAdapter } from '../testkit';
import { kitFor } from '../tray';
import { AXIS_LOCK_CM, CHIPS, FOLLOW_PAUSE_MS, codeLineRect, createCodingKit, INDENT_CM, LINE_H, SLOTS, TRACE_DWELL_MS, traceMarkerRect, visibleLines } from './coding';

const LINES: BoardCode['lines'] = [
  { id: 'l1', indent: 0, text: 'def two_sum(nums, target):', src: 'scribe' },
  { id: 'l2', indent: 1, text: 'seen = {}', src: 'scribe' },
  { id: 'l3', indent: 1, text: 'for i, x in enumerate(nums):', src: 'scribe' },
  { id: 'l4', indent: 2, text: 'if target - x in seen:', src: 'scribe' },
  { id: 'l5', indent: 3, text: 'return [seen[target - x], i]', src: 'scribe' },
];

function codingBoard(lines = LINES): Board {
  return { ...emptyBoard({ kit: 'coding' }), code: { language: 'python', lines, approach: ['Hash map of value to index'], complexity: { time: null, space: null }, trace: [] } };
}

function setup(kit = createCodingKit()) {
  const store = new BoardStore(codingBoard());
  const adapter = new FakeAdapter();
  const emitted: BoardOp[] = [];
  new BoardInput(store, adapter, kit, (op) => {
    emitted.push(op);
    store.apply(op, { local: true });
  }, { now_s: () => 300 });
  return { store, adapter, emitted, kit };
}

const ids = (b: Board) => b.code!.lines.map((l) => l.id);

describe('coding kit', () => {
  it('drags a line down two rows: one code.move', () => {
    const { store, adapter, emitted, kit } = setup();
    const r = codeLineRect(kit.panel!, 1);
    const to = codeLineRect(kit.panel!, 3);
    adapter.stroke([[r.x + 6, r.y + r.h / 2], [r.x + 6, r.y + 2], [r.x + 6, to.y + to.h / 2]]);
    expect(emitted).toEqual([expect.objectContaining({ op: 'code.move', args: { id: 'l2', after: 'l4' } })]);
    expect(ids(store.board)).toEqual(['l1', 'l3', 'l4', 'l2', 'l5']);
  });

  it('moves a line to the top with after null', () => {
    const { store, adapter, kit } = setup();
    const r = codeLineRect(kit.panel!, 2);
    const top = codeLineRect(kit.panel!, 0);
    adapter.stroke([[r.x + 6, r.y + r.h / 2], [r.x + 6, r.y - 1], [r.x + 6, top.y + 0.2]]);
    expect(ids(store.board)[0]).toBe('l3');
  });

  it('indent_clamped_0_to_6', () => {
    const { store, adapter, emitted, kit } = setup();
    const r = codeLineRect(kit.panel!, 3);
    // Far right: 6 levels and more, clamped to 6 (from 2: delta 4).
    adapter.stroke([[r.x + 6, r.y + r.h / 2], [r.x + 9, r.y + r.h / 2], [r.x + 6 + 9 * INDENT_CM, r.y + r.h / 2]]);
    expect(emitted[0]).toMatchObject({ op: 'code.indent', args: { id: 'l4', delta: 4 } });
    expect(store.board.code!.lines[3]!.indent).toBe(6);
    // Far left: back to 0, never below.
    const r0 = codeLineRect(kit.panel!, 0);
    adapter.stroke([[r0.x + 20, r0.y + r0.h / 2], [r0.x + 17, r0.y + r0.h / 2], [r0.x + 20 - 5 * INDENT_CM, r0.y + r0.h / 2]]);
    expect(emitted).toHaveLength(1);
    // And the apply rule clamps whatever arrives.
    const b = applyOp(store.board, { op_id: 'x', src: 'hand', op: 'code.indent', args: { id: 'l1', delta: -3 } });
    expect(b.code!.lines[0]!.indent).toBe(0);
  });

  it('drags a line onto the bin to delete it', () => {
    const { store, adapter, kit } = setup();
    const r = codeLineRect(kit.panel!, 1);
    const bin = kit.bin;
    adapter.stroke([[r.x + 6, r.y + r.h / 2], [40, 20], [bin.x + 2, bin.y + 2]]);
    expect(ids(store.board)).toEqual(['l1', 'l3', 'l4', 'l5']);
  });

  it('drops a complexity chip on the Time and Space slots', () => {
    const { store, adapter, emitted } = setup();
    const chip = (v: string) => createCodingKit().tray.find((s) => s.name === v)!;
    const on = (r: { x: number; y: number; w: number; h: number }) => [r.x + r.w / 2, r.y + r.h / 2] as [number, number];
    adapter.stroke([[chip('O(n)').x + 2, chip('O(n)').y + 1], [10, 20], on(SLOTS.time)]);
    adapter.stroke([[chip('O(1)').x + 2, chip('O(1)').y + 1], [10, 20], on(SLOTS.space)]);
    adapter.stroke([[chip('O(n²)').x + 2, chip('O(n²)').y + 1], [10, 20], [50, 10]]);
    expect(emitted.map((o) => o.args)).toEqual([
      { slot: 'time', value: 'O(n)' },
      { slot: 'space', value: 'O(1)' },
    ]);
    expect(store.board.code!.complexity).toEqual({ time: 'O(n)', space: 'O(1)' });
    expect(CHIPS).toEqual(['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n²)', 'O(2ⁿ)']);
  });

  it('walks the trace marker down the lines: one code.trace per line it stops on', () => {
    const { store, adapter, kit } = setup();
    const m = traceMarkerRect(kit.panel!, store.board);
    const start: [number, number] = [m.x + m.w / 2, m.y + m.h / 2];
    const mid = (i: number) => codeLineRect(kit.panel!, i).y + LINE_H / 2;
    adapter.down(...start);
    for (const i of [1, 2, 3]) {
      adapter.move(start[0], mid(i));
      adapter.wait(TRACE_DWELL_MS + 10);
      adapter.move(start[0], mid(i) + 0.05);
    }
    adapter.up(start[0], mid(3));
    expect(store.board.code!.trace.map((t) => [t.line, t.t])).toEqual([
      ['l2', 300],
      ['l3', 300],
      ['l4', 300],
    ]);
  });

  it('the trace marker ignores a hand jittering on a line boundary (hysteresis), and lines it only passes', () => {
    const { store, adapter, emitted, kit } = setup();
    const m = traceMarkerRect(kit.panel!, store.board);
    const x = m.x + m.w / 2;
    const boundary = codeLineRect(kit.panel!, 1).y;
    adapter.down(x, m.y + m.h / 2);
    // A few mm either side of the line 1 / line 2 boundary, held well past the dwell.
    for (let i = 0; i < 20; i++) {
      adapter.move(x, boundary + (i % 2 ? 0.3 : -0.3));
      adapter.wait(TRACE_DWELL_MS);
    }
    expect(emitted).toEqual([]);
    // Sweeping through lines 2 and 3 without stopping, then stopping on line 4: only line 4.
    adapter.move(x, codeLineRect(kit.panel!, 1).y + LINE_H / 2);
    adapter.move(x, codeLineRect(kit.panel!, 2).y + LINE_H / 2);
    adapter.move(x, codeLineRect(kit.panel!, 3).y + LINE_H / 2);
    adapter.wait(TRACE_DWELL_MS + 10);
    adapter.move(x, codeLineRect(kit.panel!, 3).y + LINE_H / 2 + 0.1);
    adapter.up(x, codeLineRect(kit.panel!, 3).y + LINE_H / 2 + 0.1);
    expect(emitted.map((o) => o.args)).toEqual([{ line: 'l4', t: 300 }]);
  });

  it('a pinch on the trace marker logs the line it is on (so the first line can be traced), once', () => {
    const { store, adapter, emitted, kit } = setup();
    const m = traceMarkerRect(kit.panel!, store.board);
    adapter.stroke([[m.x + m.w / 2, m.y + m.h / 2]]);
    adapter.stroke([[m.x + m.w / 2, m.y + m.h / 2]]);
    expect(emitted.map((o) => o.args)).toEqual([{ line: 'l1', t: 300 }]);
    // Letting go clearly inside another line logs it (a release is a stop).
    adapter.stroke([[m.x + m.w / 2, m.y + m.h / 2], [m.x + m.w / 2, codeLineRect(kit.panel!, 2).y + LINE_H / 2]]);
    expect(emitted.map((o) => (o.args as { line: string }).line)).toEqual(['l1', 'l3']);
  });

  it('axis lock: a sideways indent nudge that drifts down does not reorder', () => {
    const { store, adapter, emitted, kit } = setup();
    const r = codeLineRect(kit.panel!, 1);
    const y = r.y + r.h / 2;
    // The first centimetre is mostly sideways: indent. Then 1.2 cm of vertical drift.
    adapter.stroke([[r.x + 6, y], [r.x + 6 + AXIS_LOCK_CM + 0.2, y + 0.2], [r.x + 6 + INDENT_CM + 0.2, y + 1.2]]);
    expect(emitted).toEqual([expect.objectContaining({ op: 'code.indent', args: { id: 'l2', delta: 1 } })]);
    expect(ids(store.board)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    // And a drag that starts down keeps reordering only, whatever it does sideways.
    const r3 = codeLineRect(kit.panel!, 3);
    adapter.stroke([[r3.x + 6, r3.y + r3.h / 2], [r3.x + 6.2, r3.y + r3.h / 2 - AXIS_LOCK_CM - 0.2], [r3.x + 6 + 2 * INDENT_CM, r3.y + r3.h / 2 - LINE_H]]);
    expect(emitted.slice(1)).toEqual([expect.objectContaining({ op: 'code.move', args: { id: 'l4', after: 'l2' } })]);
  });

  it('reorders by how far the hand moved, not where it was pinched: small drift never reorders', () => {
    const { adapter, emitted, kit } = setup();
    const r = codeLineRect(kit.panel!, 1);
    // Pinched near the lower edge, drifting 0.7 cm down into the next line: nothing.
    adapter.stroke([[r.x + 6, r.y + r.h - 0.1], [r.x + 6, r.y + r.h + 0.2], [r.x + 6, r.y + r.h + 0.6]]);
    expect(emitted).toEqual([]);
    // One line's travel moves it one line.
    adapter.stroke([[r.x + 6, r.y + 0.2], [r.x + 6, r.y + 1.4], [r.x + 6, r.y + 0.2 + LINE_H]]);
    expect(emitted).toEqual([expect.objectContaining({ op: 'code.move', args: { id: 'l2', after: 'l3' } })]);
  });

  it('pushing a line far to the right only indents it; off the panel toward the sheet deletes it', () => {
    const { store, adapter, emitted, kit } = setup();
    const r = codeLineRect(kit.panel!, 4);
    adapter.stroke([[r.x + 30, r.y + r.h / 2], [r.x + 32, r.y + r.h / 2], [r.x + 30 + 20, r.y + r.h / 2]]);
    expect(emitted.map((o) => o.op)).toEqual(['code.indent']);
    const r1 = codeLineRect(kit.panel!, 1);
    adapter.stroke([[r1.x + 6, r1.y + r1.h / 2], [r1.x, r1.y + r1.h / 2], [kit.panel!.x - 10, r1.y + r1.h / 2]]);
    expect(emitted.map((o) => o.op)).toEqual(['code.indent', 'code.delete']);
    expect(ids(store.board)).toEqual(['l1', 'l3', 'l4', 'l5']);
  });

  it('a line held over the bin lights it', () => {
    const { store, adapter, kit } = setup();
    const input = new BoardInput(store, adapter, kit, () => {});
    const r = codeLineRect(kit.panel!, 1);
    adapter.down(r.x + 6, r.y + r.h / 2);
    adapter.move(kit.bin.x + 2, kit.bin.y + 2);
    const o = input.overlays.find((x) => x.kind === 'kit');
    expect(o).toMatchObject({ kind: 'kit', draw: { overBin: true } });
  });

  it('long code scrolls: tap the "more" strip to page, pull it to scroll, and lines map to what is shown', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `l${i + 1}`, indent: 1, text: `x${i + 1} = ${i}`, src: 'scribe' as const }));
    const store = new BoardStore(codingBoard(many));
    const adapter = new FakeAdapter();
    const kit = createCodingKit();
    const emitted: BoardOp[] = [];
    new BoardInput(store, adapter, kit, (op) => {
      emitted.push(op);
      store.apply(op, { local: true });
    }, { now_s: () => 1 });
    const p = kit.panel!;
    const rows = visibleLines(p);
    expect(rows).toBeGreaterThanOrEqual(15);
    const footerY = codeLineRect(p, rows - 1).y + LINE_H + 0.8;
    expect(kit.panelKey!(store.board)).toBe('0');
    adapter.stroke([[p.x + 20, footerY]]);
    const top = Number(kit.panelKey!(store.board));
    expect(top).toBe(rows - 2);
    // The first row shown is now line top + 1: drag it sideways to indent that line.
    const r0 = codeLineRect(p, 0);
    adapter.stroke([[r0.x + 6, r0.y + r0.h / 2], [r0.x + 8, r0.y + r0.h / 2], [r0.x + 6 + INDENT_CM, r0.y + r0.h / 2]]);
    expect(emitted).toEqual([expect.objectContaining({ op: 'code.indent', args: { id: `l${top + 1}`, delta: 1 } })]);
    // Never past the end.
    adapter.stroke([[p.x + 20, codeLineRect(p, rows - 1).y + LINE_H + 0.8]]);
    expect(Number(kit.panelKey!(store.board))).toBe(30 - rows);
    // Pull the header down to scroll back by lines.
    adapter.stroke([[p.x + 20, p.y + 1], [p.x + 20, p.y + 3], [p.x + 20, p.y + 1 + 3 * LINE_H]]);
    expect(Number(kit.panelKey!(store.board))).toBe(30 - rows - 3);
  });

  describe('the panel follows the Scribe', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i + 1}`, indent: 1, text: `x${i + 1} = ${i}`, src: 'scribe' as const }));
    const ins = (store: BoardStore, id: string, after: string) =>
      store.apply({ op_id: `o-${id}`, src: 'scribe', op: 'code.insert', args: { line: { id, indent: 1, text: `new ${id}`, src: 'scribe' }, after } });
    function follow(n = 20) {
      let t = 100_000;
      const kit = createCodingKit({ now: () => t });
      const store = new BoardStore(codingBoard(many(n)));
      const adapter = new FakeAdapter();
      new BoardInput(store, adapter, kit, (op) => store.apply(op, { local: true }), { now_s: () => 1 });
      const key = () => kit.panelKey!(store.board);
      key();
      return { kit, store, adapter, key, rows: visibleLines(kit.panel!), tick: (ms: number) => (t += ms) };
    }

    it('a line the Scribe adds past the last row scrolls the panel to show it', () => {
      const { store, key, rows } = follow(20);
      expect(rows).toBe(16);
      expect(key()).toBe('0');
      ins(store, 'l21', 'l20');
      expect(key()).toBe('5');
      // An edit to a line above the view brings that line back into view.
      store.apply({ op_id: 'e1', src: 'scribe', op: 'code.edit', args: { id: 'l2', text: 'seen = set()' } });
      expect(key()).toBe('1');
    });

    it('edits above the view do not shift the lines shown (the view is anchored to its first line)', () => {
      const { store, adapter, kit, key } = follow(30);
      // Page down by hand, then wait out the pause.
      const p = kit.panel!;
      adapter.stroke([[p.x + 20, codeLineRect(p, 15).y + LINE_H + 0.8]]);
      const top = Number(key());
      expect(top).toBe(14);
      store.apply({ op_id: 'd1', src: 'scribe', op: 'code.delete', args: { id: 'l1' } });
      // l15 is still the first line shown, now at index 13.
      expect(key()).toBe('13');
      expect(store.board.code!.lines[13]!.id).toBe('l15');
    });

    it('after a manual scroll it does not jump for 5 s: it shows a "new line below" cue, and a tap on it shows the line', () => {
      const { store, adapter, kit, key, tick } = follow(40);
      const p = kit.panel!;
      const footer: [number, number] = [p.x + 20, codeLineRect(p, 15).y + LINE_H + 0.8];
      // Page down once by hand (top 14), then the Scribe adds a line at the end.
      adapter.stroke([footer]);
      expect(key()).toBe('14');
      tick(1000);
      ins(store, 'l41', 'l40');
      expect(key()).toBe('14:below');
      // A tap on the cue shows that line on the last row.
      adapter.stroke([footer]);
      expect(key()).toBe(String(41 - 16));
      // Past the pause it follows again.
      tick(FOLLOW_PAUSE_MS + 1);
      adapter.stroke([[p.x + 20, p.y + 1]]);
      expect(Number(key())).toBeLessThan(25);
      tick(FOLLOW_PAUSE_MS + 1);
      ins(store, 'l42', 'l41');
      expect(key()).toBe(String(42 - 16));
    });

    it('never scrolls while a line is held; the cue shows instead, and a cancelled press lets it follow again', () => {
      const { store, adapter, kit, key } = follow(20);
      const r = codeLineRect(kit.panel!, 3);
      adapter.down(r.x + 6, r.y + r.h / 2);
      ins(store, 'l21', 'l20');
      expect(key()).toBe('0:below');
      adapter.cancel(r.x + 6, r.y + r.h / 2);
      ins(store, 'l22', 'l21');
      expect(key()).toBe(String(22 - 16));
    });
  });

  it('the trace marker, when its line is scrolled away, does not log the row it is drawn on', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ id: `l${i + 1}`, indent: 1, text: `x${i + 1}`, src: 'scribe' as const }));
    const kit = createCodingKit();
    const store = new BoardStore({ ...codingBoard(lines), code: { ...codingBoard(lines).code!, trace: [{ line: 'l2', t: 1 }] } });
    const adapter = new FakeAdapter();
    const emitted: BoardOp[] = [];
    new BoardInput(store, adapter, kit, (op) => {
      emitted.push(op);
      store.apply(op, { local: true });
    }, { now_s: () => 5 });
    const p = kit.panel!;
    adapter.stroke([[p.x + 20, codeLineRect(p, 15).y + LINE_H + 0.8]]);
    expect(Number(kit.panelKey!(store.board))).toBeGreaterThan(2);
    const m = traceMarkerRect(p, store.board, Number(kit.panelKey!(store.board)));
    adapter.stroke([[m.x + m.w / 2, m.y + m.h / 2]]);
    expect(emitted).toEqual([]);
  });

  it('puts the panel on the dominant side', () => {
    const right = createCodingKit();
    expect(right.panel!.x).toBeGreaterThan(64);
    expect(kitFor(right, 'left').panel!.x + kitFor(right, 'left').panel!.w).toBeLessThan(0);
  });
});

describe('Parsons puzzle', () => {
  const solution = ['l1', 'l2', 'l3', 'l4', 'l5'];

  it('parsons keeps the first and last lines locked in place and shuffles the rest with the distractors', () => {
    const blocks = parsons(LINES, ['seen.add(x)'], 7);
    expect(blocks).toHaveLength(6);
    expect(blocks[0]).toMatchObject({ id: 'l1', locked: true });
    expect(blocks.at(-1)).toMatchObject({ id: 'l5', locked: true });
    expect(blocks.filter((b) => b.distractor)).toHaveLength(1);
    expect(blocks.slice(1, -1).map((b) => b.id)).not.toEqual(['l2', 'l3', 'l4']);
    // Shuffled lines start flat; the indent is part of the puzzle.
    expect(blocks.slice(1, -1).every((b) => b.indent === 0)).toBe(true);
    expect(parsons(LINES, ['seen.add(x)'], 7)).toEqual(blocks);
  });

  it('parsons_detects_first_wrong', () => {
    expect(checkParsons(solution, solution)).toEqual({ correct: true, firstWrongIndex: null });
    expect(checkParsons(['l1', 'l3', 'l2', 'l4', 'l5'], solution)).toEqual({ correct: false, firstWrongIndex: 1 });
    expect(checkParsons(['l1', 'l2', 'l3', 'l4'], solution)).toEqual({ correct: false, firstWrongIndex: 4 });
    // A distractor left in is wrong where it stands.
    expect(checkParsons(['l1', 'l2', 'd1', 'l3', 'l4', 'l5'], solution)).toEqual({ correct: false, firstWrongIndex: 2 });
  });

  it('checkParsons checks indents too: the right order at a wrong indent is wrong there', () => {
    const want = parsonsAnswer(LINES);
    expect(checkParsons(want, want)).toEqual({ correct: true, firstWrongIndex: null });
    const flat = LINES.map((l) => ({ id: l.id, indent: 0 }));
    expect(checkParsons(flat, want)).toEqual({ correct: false, firstWrongIndex: 1 });
    const oneOff = want.map((l) => (l.id === 'l4' ? { ...l, indent: 1 } : l));
    expect(checkParsons(oneOff, want)).toEqual({ correct: false, firstWrongIndex: 3 });
  });

  it('parsons never deals the solution order, whatever the seed', () => {
    for (let middle = 2; middle <= 5; middle++) {
      const lines = Array.from({ length: middle + 2 }, (_, i) => ({ id: `l${i + 1}`, text: `line ${i + 1}`, indent: 1 }));
      for (const distractors of [[], ['x'], ['x', 'y']]) {
        for (let seed = 1; seed <= 300; seed++) {
          const real = parsons(lines, distractors, seed).filter((b) => !b.distractor).map((b) => b.id);
          expect(real).not.toEqual(lines.map((l) => l.id));
        }
      }
    }
  });

  it('a Parsons block is indented like any code line, and the check sees it', () => {
    const blocks = parsons(LINES, ['seen.add(x)'], 7);
    const kit = createCodingKit({ locked: ['l1', 'l5'] });
    // Board lines as dealt (the session writes them; here straight into a fresh board).
    const dealt = new BoardStore(codingBoard(blocks.map((b) => ({ id: b.id, indent: b.indent, text: b.text, src: 'scribe' as const }))));
    const a = new FakeAdapter();
    new BoardInput(dealt, a, kit, (op) => dealt.apply(op, { local: true }), { now_s: () => 1 });
    const row = dealt.board.code!.lines.findIndex((l) => l.id === 'l2');
    const r = codeLineRect(kit.panel!, row);
    a.stroke([[r.x + 6, r.y + r.h / 2], [r.x + 8, r.y + r.h / 2], [r.x + 6 + INDENT_CM, r.y + r.h / 2]]);
    expect(dealt.board.code!.lines.find((l) => l.id === 'l2')!.indent).toBe(1);
    const res = checkParsons(parsonsAnswer(dealt.board.code!.lines), parsonsAnswer(LINES));
    expect(res.correct).toBe(false);
  });

  it('lines that read the same are interchangeable, and the shuffle never swaps two identical lines', () => {
    const sol = [
      { id: 'a', indent: 0, text: 'def f(xs):' },
      { id: 'b', indent: 1, text: 'i += 1' },
      { id: 'c', indent: 1, text: 'i += 1' },
      { id: 'd', indent: 1, text: 'return i' },
    ];
    const swapped = [sol[0]!, sol[2]!, sol[1]!, sol[3]!];
    expect(checkParsons(parsonsAnswer(swapped), parsonsAnswer(sol))).toEqual({ correct: true, firstWrongIndex: null });
    const lines = [sol[0]!, sol[1]!, sol[2]!, { id: 'e', indent: 1, text: 'j += 1' }, sol[3]!];
    for (let seed = 1; seed <= 300; seed++) {
      const texts = parsons(lines, [], seed).map((b) => b.text);
      expect(texts).not.toEqual(lines.map((l) => l.text));
    }
  });

  it('a parsons kit will not move a locked line, nor drop a line above the first or below the last', () => {
    const kit = createCodingKit({ locked: ['l1', 'l5'] });
    const { store, adapter } = setup(kit);
    const first = codeLineRect(kit.panel!, 0);
    const second = codeLineRect(kit.panel!, 1);
    adapter.stroke([[first.x + 6, first.y + first.h / 2], [first.x + 6, first.y + 3], [first.x + 6, codeLineRect(kit.panel!, 3).y + 0.7]]);
    expect(ids(store.board)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    adapter.stroke([[second.x + 6, second.y + second.h / 2], [second.x + 6, first.y], [second.x + 6, first.y - 1]]);
    expect(ids(store.board)[0]).toBe('l1');
  });
});
