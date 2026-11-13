import { describe, expect, it, vi } from 'vitest';
import { emptyBoard } from '../board/model';
import { BoardStore } from '../board/ops';
import type { BoardOp, ClientMsgMap, ClientMsgType, GhostOp, ServerMsgMap, ServerMsgType } from '../shared/types';
import { syncBoard } from './boardSync';

function fakeSocket() {
  const sent: { t: string; d: unknown }[] = [];
  const handlers = new Map<string, Set<(d: never) => void>>();
  return {
    sent,
    send<T extends ClientMsgType>(t: T, d: ClientMsgMap[T]) {
      sent.push({ t, d });
    },
    on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T]) => void) {
      let set = handlers.get(t);
      if (!set) handlers.set(t, (set = new Set()));
      set.add(cb as (d: never) => void);
      return () => set.delete(cb as (d: never) => void);
    },
    server<T extends ServerMsgType>(t: T, d: ServerMsgMap[T]) {
      for (const cb of handlers.get(t) ?? []) (cb as (d: ServerMsgMap[T]) => void)(d);
    },
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

const card = (id: string, opId: string, src: BoardOp['src'] = 'hand'): BoardOp =>
  ({ op_id: opId, src, op: 'item.create', args: { kind: 'component', id, type: 'service', label: null, x: 5, y: 5, w: 12, h: 6 } }) as BoardOp;

describe('board sync', () => {
  it('a_local_op_goes_out_with_its_base_rev_and_is_confirmed_by_the_ack', () => {
    const store = new BoardStore(emptyBoard());
    const socket = fakeSocket();
    const sync = syncBoard(store, socket, () => 1234);
    const active = vi.fn();
    sync.onActivity(active);
    const op = card('n1', 'op1');
    store.apply(op, { local: true });
    sync.send(op);
    expect(socket.sent).toEqual([{ t: 'board.op', d: { ...op, rev_base: 0, at_ms: 1234 } }]);
    expect(active).toHaveBeenCalledTimes(1);
    socket.server('board.ack', { op_id: 'op1', rev: 1 });
    expect(store.log[0]).toMatchObject({ confirmed: true });
    expect(store.board.items).toHaveLength(1);
  });

  it('a_rejected_op_is_rolled_back', () => {
    const store = new BoardStore(emptyBoard());
    const socket = fakeSocket();
    const sync = syncBoard(store, socket);
    const op = card('n1', 'op1');
    store.apply(op, { local: true });
    sync.send(op);
    socket.server('error', { code: 'op_rejected', message: 'no', op_id: 'op1' });
    expect(store.board.items).toHaveLength(0);
    expect(store.board.rev).toBe(0);
    // Other errors are not the board's.
    socket.server('error', { code: 'server_error', message: 'x' });
  });

  it('server_ops_and_ghosts_reach_the_store_and_focus_and_rejects_go_out', () => {
    const store = new BoardStore(emptyBoard());
    const socket = fakeSocket();
    const sync = syncBoard(store, socket);
    const { op_id, src, op, args } = card('n9', 'srv1', 'interviewer') as BoardOp & { op: 'item.create' };
    socket.server('board.apply', { op_id, src, op, args, rev: 1 } as ServerMsgMap['board.apply']);
    expect(store.board.items.map((i) => i.id)).toEqual(['n9']);
    expect(store.board.rev).toBe(1);

    const ghost = { op_id: 'g1', src: 'scribe', op: 'item.label', args: { id: 'n9', text: 'Cache' } } as GhostOp;
    socket.server('board.ghosts', { ghosts: [ghost] });
    expect(store.board.ghosts.map((g) => g.op_id)).toEqual(['g1']);

    sync.sendGhostReject('g1');
    sync.sendFocus('n9');
    sync.sendFocus(null);
    expect(socket.sent).toEqual([
      { t: 'board.ghost_reject', d: { op_id: 'g1' } },
      { t: 'board.focus', d: { item_id: 'n9' } },
      { t: 'board.focus', d: { item_id: null } },
    ]);
    sync.dispose();
    expect(socket.listeners()).toBe(0);
  });
});
