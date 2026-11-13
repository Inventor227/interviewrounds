import { describe, expect, it } from 'vitest';
import type { Board, BoardCode, BoardOp } from '../../shared/types';
import { BoardInput } from '../input';
import { emptyBoard } from '../model';
import { applyOp, BoardStore } from '../ops';
import { checkParsons, parsons } from '../parsons';
import { FakeAdapter } from '../testkit';
import { kitFor } from '../tray';
import { CHIPS, codeLineRect, createCodingKit, INDENT_CM, SLOTS, traceMarkerRect } from './coding';

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

  it('walks the trace marker down the lines, one code.trace per line it reaches', () => {
    const { store, adapter, kit } = setup();
    const m = traceMarkerRect(kit.panel!, store.board);
    const start: [number, number] = [m.x + m.w / 2, m.y + m.h / 2];
    adapter.down(...start);
    for (const i of [1, 1, 2, 3]) {
      const r = codeLineRect(kit.panel!, i);
      adapter.move(start[0], r.y + r.h / 2);
    }
    adapter.up(start[0], codeLineRect(kit.panel!, 3).y + 0.7);
    expect(store.board.code!.trace.map((t) => [t.line, t.t])).toEqual([
      ['l2', 300],
      ['l3', 300],
      ['l4', 300],
    ]);
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
