import { describe, expect, it } from 'vitest';
import type { Board, BoardOp, StickyItem } from '../../shared/types';
import { BoardInput } from '../input';
import { emptyBoard } from '../model';
import { BoardStore } from '../ops';
import { FakeAdapter } from '../testkit';
import { LADDER, laneAt, PM_KIT, rungAt, rungRect } from './pm';
import { pmLines } from './summary';

const sticky = (id: string, over: Partial<StickyItem>): StickyItem => ({ id, kind: 'sticky', lane: null, text: id, votes: 0, quad: null, x: 0, y: 0, ...over });

function setup(items: Board['items'] = []) {
  const store = new BoardStore({ ...emptyBoard({ kit: 'pm' }), items });
  const adapter = new FakeAdapter();
  const emitted: BoardOp[] = [];
  new BoardInput(store, adapter, PM_KIT, (op) => {
    emitted.push(op);
    store.apply(op, { local: true });
  });
  return { store, adapter, emitted };
}

describe('PM summary text (as server/src/board/summary.rs prints it)', () => {
  it('pm_summary_prints_lanes', () => {
    const b: Board = {
      ...emptyBoard({ kit: 'pm' }),
      items: [
        sticky('s1', { lane: 'user', text: 'Commuters' }),
        sticky('s2', { lane: 'pain', text: 'Cannot find parking', votes: 2 }),
        sticky('s10', { lane: 'pain', text: 'Late for standup' }),
        sticky('s3', { lane: 'idea', text: 'Carpool app', rank: 1 }),
        sticky('s4', { lane: 'idea', text: 'Shuttle bus', rank: 2, votes: 1 }),
        sticky('s5', { lane: 'metric', text: 'Weekly riders' }),
        sticky('s6', { text: 'Loose idea' }),
      ],
    };
    expect(pmLines(b)).toEqual([
      'Users: s1 "Commuters".',
      'Pain points: s2 "Cannot find parking" (2 votes); s10 "Late for standup".',
      'Ideas: s3 "Carpool app"; s4 "Shuttle bus" (1 vote).',
      'Metrics lane: s5 "Weekly riders".',
      'Other stickies: s6 "Loose idea".',
      'Ladder: 1 s3; 2 s4.',
    ]);
  });
});

describe('PM kit', () => {
  it('has four lanes across the sheet and a five rung ladder', () => {
    expect(laneAt(5)).toBe('user');
    expect(laneAt(20)).toBe('pain');
    expect(laneAt(30)).toBe('idea');
    expect(laneAt(45)).toBe('metric');
    expect(rungAt(LADDER.x + 3, rungRect(1).y + 1)).toBe(1);
    expect(rungAt(LADDER.x + 3, rungRect(5).y + 1)).toBe(5);
    expect(rungAt(20, 20)).toBeNull();
  });

  it('a sticky from the pad lands in the lane it is dropped in', () => {
    const { adapter, emitted } = setup();
    const pad = PM_KIT.tray.find((s) => s.make.kind === 'sticky')!;
    adapter.stroke([[pad.x + 2, pad.y + 1], [10, 20], [20, 20]]);
    expect(emitted[0]).toMatchObject({ op: 'item.create', args: { kind: 'sticky', lane: 'pain', text: '', votes: 0 } });
  });

  it('dragging a sticky to another lane files it there', () => {
    const { adapter, emitted } = setup([sticky('s1', { lane: 'pain', x: 13, y: 10 })]);
    adapter.stroke([[16.5, 13.5], [25, 14], [30, 14]]);
    expect(emitted[0]).toMatchObject({ op: 'item.move', args: { id: 's1', lane: 'idea' } });
    // Centred in the lane.
    expect((emitted[0]!.args as { x: number }).x).toBe(24 + 2.5);
  });

  it('ladder_reorder_is_one_op', () => {
    const r1 = rungRect(1);
    const r2 = rungRect(2);
    const { store, adapter, emitted } = setup([
      sticky('s1', { lane: 'idea', rank: 1, x: r1.x + 0.5, y: r1.y }),
      sticky('s2', { lane: 'idea', rank: 2, x: r2.x + 0.5, y: r2.y }),
    ]);
    // Drag the second option up to the top rung.
    adapter.stroke([[r2.x + 4, r2.y + 3.5], [r2.x + 4, r1.y + 5], [r1.x + 8, r1.y + 3.5]]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: 'item.move', args: { id: 's2', rank: 1 } });
    // It sits in the rung's free slot (s1 holds the first), not wherever it was let go.
    const a = emitted[0]!.args as { x: number; y: number };
    expect(a.y).toBeGreaterThanOrEqual(r1.y);
    expect(a.y + 7).toBeLessThanOrEqual(r1.y + r1.h);
    expect(a.x).toBeGreaterThanOrEqual(r1.x + 7);
    expect((store.board.items[1] as StickyItem).rank).toBe(1);
    // Off the ladder into a lane: it leaves the ladder.
    adapter.stroke([[a.x + 3.5, a.y + 3.5], [30, 20], [20, 20]]);
    expect(emitted[1]).toMatchObject({ op: 'item.move', args: { id: 's2', lane: 'pain', rank: null } });
  });
});
