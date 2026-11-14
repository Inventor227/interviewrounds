import { describe, expect, it } from 'vitest';
import type { GhostOp } from '../shared/types';
import { destack } from './destack';
import { ghostRect } from './ghosts';
import { emptyBoard, type Rect } from './model';
import { BoardStore } from './ops';

const sticky = (opId: string, id: string, text: string, x: number, y: number, lane = 'pain'): GhostOp =>
  ({ op_id: opId, src: 'scribe', op: 'item.create', args: { id, kind: 'sticky', lane, text, votes: 0, quad: null, x, y } }) as GhostOp;
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('suggestions never stack', () => {
  it('a_second_call_s_sticky_on_the_first_one_moves_to_a_free_spot', () => {
    // Two Scribe calls in a row, both placing their sticky at the first free position.
    const store = new BoardStore(emptyBoard({ kit: 'pm' }));
    store.apply({ op_id: 'h1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'sticky', lane: 'user', text: 'Students', votes: 0, quad: null, x: 14.5, y: 3 } });
    store.setGhosts([sticky('sc1.1', 'x1_1', 'Deposits get lost', 2, 2)]);
    store.setGhosts([sticky('sc1.1', 'x1_1', 'Deposits get lost', 2, 2), sticky('sc2.1', 'x2_1', 'Scams', 2, 2)]);
    const [first, second] = store.board.ghosts;
    expect(first!.args).toMatchObject({ x: 2, y: 2 }); // the one already shown stays put
    // A pain sticky moves down the pain lane's column (12 to 24 cm), under what is already there.
    expect(second!.args).toMatchObject({ x: 14.5, y: 11 });
    const r1 = ghostRect(store.board, first!)!;
    const r2 = ghostRect(store.board, second!)!;
    expect(overlap(r1, r2)).toBe(false);
    // ... and clear of the sticky already on the board.
    expect(overlap(r2, { x: 14.5, y: 3, w: 7, h: 7 })).toBe(false);
    // The same list again lands in the same places.
    store.setGhosts([sticky('sc1.1', 'x1_1', 'Deposits get lost', 2, 2), sticky('sc2.1', 'x2_1', 'Scams', 2, 2)]);
    expect(store.board.ghosts[1]!.args).toEqual(second!.args);
  });

  it('a_suggestion_never_moves_back_onto_the_one_just_accepted', () => {
    const store = new BoardStore(emptyBoard({ kit: 'pm' }));
    const g1 = sticky('sc1.1', 'x1_1', 'Deposits get lost', 14.5, 3);
    const g2 = sticky('sc1.2', 'x1_2', 'Scams', 14.5, 3);
    store.setGhosts([g1, g2]);
    expect(store.board.ghosts[1]!.args).toMatchObject({ x: 14.5, y: 11 });
    // g1 is accepted (it becomes a board item); the server's next list still has g2 where it first put it.
    store.apply({ op_id: 'sc1.1', src: 'scribe', op: 'item.create', args: g1.args } as never);
    store.setGhosts([g2]);
    const shown = store.board.ghosts[0]!;
    expect(overlap(ghostRect(store.board, shown)!, { x: 14.5, y: 3, w: 7, h: 7 })).toBe(false);
    expect(shown.args).toMatchObject({ x: 14.5, y: 11 });
  });

  it('a_full_lane_keeps_its_sticky_in_its_own_column', () => {
    const store = new BoardStore(emptyBoard({ kit: 'pm' }));
    // Four ideas fill the idea lane (x 24 to 36); a fifth comes on top of the first.
    for (const [i, y] of [3, 11, 19, 27].entries()) {
      store.apply({ op_id: `h${i}`, src: 'hand', op: 'item.create', args: { id: `n${i}`, kind: 'sticky', lane: 'idea', text: `Idea ${i}`, votes: 0, quad: null, x: 26.5, y } } as never);
    }
    store.setGhosts([sticky('sc2.1', 'x2_1', 'Verified listings', 26.5, 3, 'idea')]);
    const g = store.board.ghosts[0]!;
    expect((g.args as { x: number }).x).toBe(26.5); // still the idea column, never another lane or the ladder
    expect((g.args as { y: number }).y).toBeGreaterThan(27);
  });

  it('leaves_apart_suggestions_and_other_ops_alone', () => {
    const board = emptyBoard({ kit: 'pm' });
    const apart = [sticky('a', 'x1_1', 'One', 2, 2), sticky('b', 'x1_2', 'Two', 30, 20)];
    expect(destack(board, apart)).toEqual(apart);
    const label: GhostOp = { op_id: 'c', src: 'scribe', op: 'item.label', args: { id: 'n1', text: 'Orders' } } as GhostOp;
    expect(destack(board, [label])).toEqual([label]);
  });
});
