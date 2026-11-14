import { describe, expect, it } from 'vitest';
import type { GhostOp } from '../shared/types';
import { destack } from './destack';
import { ghostRect } from './ghosts';
import { emptyBoard, type Rect } from './model';
import { BoardStore } from './ops';

const sticky = (opId: string, id: string, text: string, x: number, y: number): GhostOp =>
  ({ op_id: opId, src: 'scribe', op: 'item.create', args: { id, kind: 'sticky', lane: 'pain', text, votes: 0, quad: null, x, y } }) as GhostOp;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('suggestions never stack', () => {
  it('a_second_call_s_sticky_on_the_first_one_moves_to_a_free_spot', () => {
    // Two Scribe calls in a row, both placing their sticky at the first free position.
    const store = new BoardStore(emptyBoard({ kit: 'pm' }));
    store.apply({ op_id: 'h1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'sticky', lane: 'user', text: 'Students', votes: 0, quad: null, x: 20, y: 2 } });
    store.setGhosts([sticky('sc1.1', 'x1_1', 'Deposits get lost', 2, 2)]);
    store.setGhosts([sticky('sc1.1', 'x1_1', 'Deposits get lost', 2, 2), sticky('sc2.1', 'x2_1', 'Scams', 2, 2)]);
    const [first, second] = store.board.ghosts;
    expect(first!.args).toMatchObject({ x: 2, y: 2 }); // the one already shown stays put
    const r1 = ghostRect(store.board, first!)!;
    const r2 = ghostRect(store.board, second!)!;
    expect(overlap(r1, r2)).toBe(false);
    // ... and clear of the sticky already on the board.
    expect(overlap(r2, { x: 20, y: 2, w: 7, h: 7 })).toBe(false);
    // The same list again lands in the same places.
    store.setGhosts([sticky('sc1.1', 'x1_1', 'Deposits get lost', 2, 2), sticky('sc2.1', 'x2_1', 'Scams', 2, 2)]);
    expect(store.board.ghosts[1]!.args).toEqual(second!.args);
  });

  it('leaves_apart_suggestions_and_other_ops_alone', () => {
    const board = emptyBoard({ kit: 'pm' });
    const apart = [sticky('a', 'x1_1', 'One', 2, 2), sticky('b', 'x1_2', 'Two', 30, 20)];
    expect(destack(board, apart)).toEqual(apart);
    const label: GhostOp = { op_id: 'c', src: 'scribe', op: 'item.label', args: { id: 'n1', text: 'Orders' } } as GhostOp;
    expect(destack(board, [label])).toEqual([label]);
  });
});
