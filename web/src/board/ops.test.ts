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
    store.apply({ op_id: 'o1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'db', label: null, x: 1, y: 1, w: 8, h: 5 } });
    store.apply({ op_id: 'o2', src: 'hand', op: 'item.move', args: { id: 'n1', x: 9, y: 9 } });
    expect(store.undoTarget()).toBe('o2');
    store.apply({ op_id: 'u1', src: 'hand', op: 'undo', args: { target_op_id: 'o2' } });
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
});
