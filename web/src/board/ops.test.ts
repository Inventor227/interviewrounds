import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardOp, BoardOpsFixture, UndoFixture } from '../shared/types';
import { emptyBoard } from './model';
import { applyOp, BoardStore, tryApplyOp } from './ops';

// Tests run from web/; the shared fixtures live at the repo root.
const FIXTURES = resolve(process.cwd(), '../content/fixtures');

function load<T>(dir: string): [string, T][] {
  const full = join(FIXTURES, dir);
  return readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(join(full, f), 'utf8')) as T]);
}

type OpsFixture = BoardOpsFixture;

/** JSON round trip: what the server would see on the wire (drops undefined keys). */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('applyOp', () => {
  const opsFixtures = load<OpsFixture>('board-ops');
  it('finds the shared fixtures', () => {
    expect(opsFixtures.length).toBeGreaterThanOrEqual(16);
  });

  it.each(opsFixtures)('applies_fixture_sequences %s', (_file, fx) => {
    const start = wire(fx.start);
    let board = start;
    for (const op of fx.ops) board = applyOp(board, op);
    expect(wire(board)).toEqual(fx.expected);
    // Pure: the start board is not mutated.
    expect(start).toEqual(fx.start);
  });

  it('duplicate_op_id_is_ignored', () => {
    const op: BoardOp = {
      op_id: 'o1',
      src: 'hand',
      op: 'item.create',
      args: { id: 'n1', kind: 'component', type: 'db', label: null, x: 1, y: 1, w: 8, h: 5 },
    };
    const once = applyOp(emptyBoard(), op);
    const twice = applyOp(once, op);
    expect(twice).toBe(once);
    expect(twice.rev).toBe(1);
    const otherArgs = applyOp(once, { ...op, args: { ...op.args, id: 'n2' } } as BoardOp);
    expect(otherArgs).toBe(once);
  });

  it('rejects schema-invalid args without changing the board', () => {
    const b = applyOp(emptyBoard(), {
      op_id: 'o1',
      src: 'hand',
      op: 'item.create',
      args: { id: 'n1', kind: 'component', type: 'db', label: null, x: 1, y: 1, w: 8, h: 5 },
    });
    const bad: unknown[] = [
      { op_id: 'o2', src: 'hand', op: 'item.move', args: { id: 'n1', x: '3', y: 1 } },
      { op_id: 'o3', src: 'hand', op: 'item.move', args: { id: 'n1', x: 3, y: 1, extra: true } },
      { op_id: 'o4', src: 'hand', op: 'item.create', args: { id: 'bad id', kind: 'component', type: 'db', label: null, x: 1, y: 1, w: 1, h: 1 } },
      { op_id: 'o5', src: 'hand', op: 'item.create', args: { id: 'n5', kind: 'component', type: 'teapot', label: null, x: 1, y: 1, w: 1, h: 1 } },
      { op_id: 'o6', src: 'robot', op: 'item.delete', args: { id: 'n1' } },
      { op_id: 'o7', src: 'hand', op: 'item.explode', args: { id: 'n1' } },
      { op_id: 'o8', src: 'hand', op: 'sticky.vote', args: { id: 'n1', delta: 2 } },
      { op_id: '', src: 'hand', op: 'item.delete', args: { id: 'n1' } },
      // board_op has additionalProperties: false.
      { op_id: 'o9', src: 'hand', op: 'item.delete', args: { id: 'n1' }, extra: 1 },
    ];
    for (const op of bad) {
      const r = tryApplyOp(b, op as BoardOp);
      expect(r.accepted, JSON.stringify(op)).toBe(false);
      expect(r.board).toBe(b);
    }
  });

  it('shares unchanged items between revisions', () => {
    let b = emptyBoard();
    b = applyOp(b, { op_id: 'o1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'db', label: null, x: 1, y: 1, w: 8, h: 5 } });
    b = applyOp(b, { op_id: 'o2', src: 'hand', op: 'item.create', args: { id: 'n2', kind: 'component', type: 'kv', label: null, x: 20, y: 1, w: 8, h: 5 } });
    const next = applyOp(b, { op_id: 'o3', src: 'hand', op: 'item.move', args: { id: 'n2', x: 30, y: 4 } });
    expect(next.items[0]).toBe(b.items[0]);
    expect(next.items[1]).not.toBe(b.items[1]);
  });

  it('rejects undo on its own: it needs the log', () => {
    const b = emptyBoard();
    const r = tryApplyOp(b, { op_id: 'u1', src: 'hand', op: 'undo', args: { target_op_id: 'o1' } });
    expect(r.accepted).toBe(false);
  });
});

describe('BoardStore undo', () => {
  it.each(load<UndoFixture>('board-undo'))('undo fixture %s', (_file, fx) => {
    const store = new BoardStore(wire(fx.start));
    for (const e of fx.log) {
      const op = { op_id: e.op_id, src: e.src, op: e.op, args: e.args } as BoardOp;
      if (e.accepted) expect(store.apply(op).accepted, e.op_id).toBe(true);
      else store.logRejected(op);
    }
    store.apply(fx.undo);
    expect(wire(store.board)).toEqual(fx.expected);
  });

  it('notifies listeners and offers the last undoable op', () => {
    const store = new BoardStore(emptyBoard());
    const seen: number[] = [];
    const off = store.onChange((b) => seen.push(b.rev));
    const local = { local: true };
    store.apply({ op_id: 'o1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'db', label: null, x: 1, y: 1, w: 8, h: 5 } }, local);
    store.apply({ op_id: 'o2', src: 'hand', op: 'item.move', args: { id: 'n1', x: 9, y: 9 } }, local);
    expect(store.undoTarget()).toBe('o2');
    store.apply({ op_id: 'u1', src: 'hand', op: 'undo', args: { target_op_id: 'o2' } }, local);
    expect(store.undoTarget()).toBe('o1');
    expect(store.board.items[0]).toMatchObject({ x: 1, y: 1 });
    off();
    store.setFocus('n1');
    expect(seen).toEqual([1, 2, 3]);
    expect(store.board.focus).toBe('n1');
  });

  it('dismissing a ghost logs it as rejected and drops it', () => {
    const start = emptyBoard();
    const store = new BoardStore(start);
    store.setGhosts([{ op_id: 'g1', src: 'scribe', op: 'park.add', args: { text: 'x' } }]);
    store.rejectGhost('g1');
    expect(store.board.ghosts).toEqual([]);
    expect(store.log.at(-1)).toMatchObject({ accepted: false });
  });

  it('undoTarget skips ops from others and ops an undo already emptied', () => {
    const store = new BoardStore(emptyBoard());
    const local = { local: true };
    store.apply({ op_id: 'o1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'db', label: null, x: 1, y: 1, w: 8, h: 5 } }, local);
    store.apply({ op_id: 'o2', src: 'hand', op: 'item.label', args: { id: 'n1', text: 'Orders' } }, local);
    // A Scribe op and another client's op: not this client's to undo.
    store.apply({ op_id: 's1', src: 'scribe', op: 'item.note.add', args: { id: 'n1', text: 'sharded' } });
    store.apply({ op_id: 'r1', src: 'hand', op: 'item.move', args: { id: 'n1', x: 5, y: 5 } });
    expect(store.undoTarget()).toBe('o2');
    // Undo the create: the label op (o2) loses its effect, so the next target is none.
    store.apply({ op_id: 'u1', src: 'hand', op: 'undo', args: { target_op_id: 'o1' } }, local);
    expect(store.undoTarget()).toBeNull();
  });

  it('does not log an op without a usable op_id', () => {
    const store = new BoardStore(emptyBoard());
    store.apply(null as unknown as BoardOp);
    store.apply({ op_id: '', src: 'hand', op: 'item.delete', args: { id: 'n1' } } as BoardOp);
    expect(store.log).toEqual([]);
    expect(store.undoTarget()).toBeNull();
  });
});

describe('BoardStore rollback of rejected optimistic ops', () => {
  const create = (op_id: string, id: string, x = 1): BoardOp => ({
    op_id,
    src: 'hand',
    op: 'item.create',
    args: { id, kind: 'component', type: 'db', label: null, x, y: 1, w: 8, h: 5 },
  });

  it('apply locally then rollback gives the board before the op', () => {
    const store = new BoardStore(emptyBoard());
    store.apply(create('o1', 'n1'), { local: true });
    store.confirm('o1');
    store.setFocus('n1');
    const before = store.board;
    store.apply({ op_id: 'o2', src: 'hand', op: 'item.move', args: { id: 'n1', x: 20, y: 20 } }, { local: true });
    expect(store.rollback('o2')).toBe(true);
    expect(wire(store.board)).toEqual(wire(before));
    expect(store.undoTarget()).toBe('o1');
  });

  it('keeps later pending ops and re-derives from confirmed plus pending', () => {
    const store = new BoardStore(emptyBoard());
    store.apply(create('o1', 'n1'), { local: true });
    store.apply(create('o2', 'n2', 20), { local: true });
    // A server op lands while both are pending.
    store.apply(create('r1', 'n3', 40));
    store.rollback('o1');
    let expected = applyOp(emptyBoard(), create('r1', 'n3', 40));
    expected = applyOp(expected, create('o2', 'n2', 20));
    expect(wire(store.board)).toEqual(wire({ ...expected, op_ids: ['o2', 'r1'] }));
    expect(store.board.rev).toBe(2);
  });

  it('a rejection of a local op through logRejected rolls it back; dependents follow when they are rejected too', () => {
    const store = new BoardStore(emptyBoard());
    store.apply(create('o1', 'n1'), { local: true });
    store.apply(create('o2', 'n2', 20), { local: true });
    store.apply({ op_id: 'o3', src: 'hand', op: 'edge.create', args: { id: 'e1', from: 'n1', to: 'n2' } }, { local: true });
    store.logRejected(create('o1', 'n1'));
    expect(store.board.items.map((i) => i.id)).toEqual(['n2']);
    expect(store.board.edges).toEqual([]);
    expect(store.board.op_ids).toEqual(['o2', 'o3']);
    store.logRejected({ op_id: 'o3', src: 'hand', op: 'edge.create', args: { id: 'e1', from: 'n1', to: 'n2' } });
    expect(wire(store.board)).toEqual(wire(applyOp(emptyBoard(), create('o2', 'n2', 20))));
  });

  it('rolling back an unknown op changes nothing', () => {
    const store = new BoardStore(emptyBoard());
    store.apply(create('o1', 'n1'), { local: true });
    const b = store.board;
    expect(store.rollback('nope')).toBe(false);
    expect(store.board).toBe(b);
  });
});
