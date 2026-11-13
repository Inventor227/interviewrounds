// The board's side of the room socket (docs/protocol.md, Board ops): local ops go out as
// `board.op` and stay pending until `board.ack`; a rejected op is rolled back; server ops
// (`board.apply`) and the Scribe's suggestions (`board.ghosts`) go into the same store.

import type { BoardStore } from '../board/ops';
import type { BoardOp, ClientMsgMap, ClientMsgType, ServerMsgMap, ServerMsgType } from '../shared/types';

export interface BoardSocket {
  send<T extends ClientMsgType>(t: T, d: ClientMsgMap[T]): void;
  on<T extends ServerMsgType>(t: T, cb: (d: ServerMsgMap[T]) => void): () => void;
}

export interface BoardSync {
  /** A local op, already applied to the store: posts board.op. */
  send(op: BoardOp): void;
  sendGhostReject(opId: string): void;
  sendFocus(itemId: string | null): void;
  /** Local changes (the user is working on the board). */
  onActivity(cb: () => void): () => void;
  dispose(): void;
}

export function syncBoard(store: BoardStore, socket: BoardSocket, now: () => number = Date.now): BoardSync {
  const activity = new Set<() => void>();
  const offs = [
    socket.on('board.ack', (d) => store.confirm(d.op_id)),
    socket.on('error', (d) => {
      if (d.code === 'op_rejected' && d.op_id) store.rollback(d.op_id);
    }),
    socket.on('board.apply', (d) => {
      const { rev: _rev, ...op } = d;
      store.apply(op as BoardOp);
    }),
    socket.on('board.ghosts', (d) => store.setGhosts(d.ghosts)),
  ];
  return {
    send(op) {
      // rev_base is informational: the rev this op was made on (the store already applied it).
      const rev_base = Math.max(0, store.board.rev - 1);
      socket.send('board.op', { ...op, rev_base, at_ms: now() } as ClientMsgMap['board.op']);
      for (const cb of [...activity]) cb();
    },
    sendGhostReject(opId) {
      socket.send('board.ghost_reject', { op_id: opId });
      for (const cb of [...activity]) cb();
    },
    sendFocus(itemId) {
      socket.send('board.focus', { item_id: itemId });
    },
    onActivity(cb) {
      activity.add(cb);
      return () => activity.delete(cb);
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      activity.clear();
    },
  };
}
