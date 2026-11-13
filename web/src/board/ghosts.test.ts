import { describe, expect, it } from 'vitest';
import type { BoardOp, GhostOp } from '../shared/types';
import { ghostRect, GhostLayer, GHOST_HOLD_MS, GHOST_SETTLE_MS } from './ghosts';
import { BoardInput } from './input';
import { HLD_KIT } from './kits';
import { emptyBoard } from './model';
import { BoardStore } from './ops';
import { FakeAdapter, roughBox } from './testkit';

const G_CARD: GhostOp = { op_id: 'g1', src: 'scribe', op: 'item.create', args: { id: 'n9', kind: 'component', type: 'cache', label: 'Redis', x: 40, y: 20, w: 8, h: 5 } };
const G_EDGE: GhostOp = { op_id: 'g2', src: 'scribe', op: 'edge.create', args: { id: 'e9', from: 'n1', to: 'n2' } };
const G_LABEL: GhostOp = { op_id: 'g3', src: 'scribe', op: 'item.label', args: { id: 'n1', text: 'Orders' } };

function setup(ghosts: GhostOp[] = [G_CARD, G_EDGE, G_LABEL]) {
  const store = new BoardStore(emptyBoard());
  store.apply({ op_id: 's1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'service', label: null, x: 4, y: 4, w: 8, h: 5 } });
  store.apply({ op_id: 's2', src: 'hand', op: 'item.create', args: { id: 'n2', kind: 'component', type: 'db', label: null, x: 24, y: 4, w: 8, h: 5 } });
  store.setGhosts(ghosts);
  const adapter = new FakeAdapter();
  let now = 0;
  const sent: BoardOp[] = [];
  const rejected: string[] = [];
  const layer = new GhostLayer(adapter, store, HLD_KIT, {
    now: () => now,
    accept: (g) => {
      const op = { op_id: g.op_id, src: 'scribe', op: g.op, args: g.args } as BoardOp;
      sent.push(op);
      store.apply(op, { local: true });
    },
    reject: (id) => {
      rejected.push(id);
      store.rejectGhost(id);
    },
  });
  const emitted: BoardOp[] = [];
  new BoardInput(store, layer, HLD_KIT, (op) => {
    emitted.push(op);
    store.apply(op, { local: true });
  });
  const tick = (ms: number) => {
    now += ms;
    adapter.wait(ms);
    layer.update(now);
  };
  return { store, adapter, layer, sent, rejected, emitted, tick, at: () => now };
}

describe('ghosts', () => {
  it('pinching a ghost card accepts it as a scribe op with the same op_id', () => {
    const { store, adapter, sent, emitted } = setup();
    adapter.down(44, 22);
    adapter.up(44, 22);
    expect(sent).toEqual([{ op_id: 'g1', src: 'scribe', op: 'item.create', args: G_CARD.args }]);
    expect(store.board.items.map((i) => i.id)).toContain('n9');
    expect(store.board.ghosts.map((g) => g.op_id)).toEqual(['g2', 'g3']);
    // The pinch belonged to the ghost: the board input saw nothing.
    expect(emitted).toEqual([]);
  });

  it('pinching the chip of a ghost edge, or the pill of a ghost label, accepts it', () => {
    const { store, adapter, sent } = setup();
    const e = ghostRect(store.board, G_EDGE)!;
    adapter.down(e.x + e.w / 2, e.y + e.h / 2);
    adapter.up(e.x + e.w / 2, e.y + e.h / 2);
    const l = ghostRect(store.board, G_LABEL)!;
    adapter.down(l.x + l.w / 2, l.y + l.h / 2);
    adapter.up(l.x + l.w / 2, l.y + l.h / 2);
    expect(sent.map((o) => o.op_id)).toEqual(['g2', 'g3']);
    expect(store.board.edges).toHaveLength(1);
    expect(store.board.items[0]).toMatchObject({ label: 'Orders' });
  });

  it('a pinch that wobbles past the drag threshold but lets go near where it started is still a tap', () => {
    const { adapter, sent } = setup();
    adapter.stroke([[44, 22], [46, 22], [44.4, 22.2]]);
    expect(sent.map((o) => o.op_id)).toEqual(['g1']);
  });

  it('a pinch-hold of 0.6 s rejects the ghost; letting go after does nothing more', () => {
    const { store, adapter, sent, rejected, tick } = setup();
    adapter.down(44, 22);
    for (let t = 0; t < GHOST_HOLD_MS / 2; t += 50) tick(50);
    expect(rejected).toEqual([]);
    for (let t = 0; t < GHOST_HOLD_MS / 2 + 50; t += 50) tick(50);
    expect(rejected).toEqual(['g1']);
    adapter.up(44, 22);
    expect(sent).toEqual([]);
    expect(store.board.ghosts.map((g) => g.op_id)).toEqual(['g2', 'g3']);
    expect(store.log.at(-1)).toMatchObject({ accepted: false, op: { op_id: 'g1' } });
  });

  it('a frame hitch during a quick pinch does not count as a hold', () => {
    const { adapter, sent, rejected, tick } = setup();
    adapter.down(44, 22);
    tick(900);
    adapter.up(44, 22);
    expect(rejected).toEqual([]);
    expect(sent.map((o) => o.op_id)).toEqual(['g1']);
  });

  it('dragging a ghost onto the bin rejects it; dropping it elsewhere keeps it', () => {
    const { adapter, sent, rejected } = setup();
    adapter.stroke([[44, 22], [50, 25], [55, 30]]);
    expect(sent).toEqual([]);
    expect(rejected).toEqual([]);
    const bin = HLD_KIT.bin;
    adapter.stroke([[44, 22], [55, 30], [bin.x + 2, bin.y + 2]]);
    expect(rejected).toEqual(['g1']);
  });

  it('ghosts settle (accept) after 4 s unless touched', () => {
    const { adapter, sent, tick, layer, at } = setup();
    tick(100);
    // Hover over the label ghost: touched, so it waits for an explicit pinch.
    adapter.move(44, 22);
    const rings = layer.rings(at());
    expect(rings.map((r) => r.op_id).sort()).toEqual(['g2', 'g3']);
    tick(GHOST_SETTLE_MS / 2);
    expect(sent).toEqual([]);
    const half = layer.rings(at()).find((r) => r.op_id === 'g2')!;
    expect(half.progress).toBeGreaterThan(0.4);
    expect(half.progress).toBeLessThan(0.6);
    tick(GHOST_SETTLE_MS / 2);
    expect(sent.map((o) => o.op_id).sort()).toEqual(['g2', 'g3']);
    tick(10000);
    expect(sent.map((o) => o.op_id)).not.toContain('g1');
  });

  it('the settle clock starts when a ghost first shows', () => {
    const { store, sent, tick } = setup([G_CARD]);
    tick(3000);
    store.setGhosts([G_CARD, G_LABEL]);
    tick(1500);
    expect(sent.map((o) => o.op_id)).toEqual(['g1']);
    tick(3000);
    expect(sent.map((o) => o.op_id)).toEqual(['g1', 'g3']);
  });

  it('pinches that miss every ghost reach the board input as usual', () => {
    const { adapter, emitted, sent } = setup();
    adapter.stroke(roughBox(20, 25, 9, 6, 0.4, 2));
    expect(sent).toEqual([]);
    expect(emitted[0]).toMatchObject({ op: 'item.create', args: { kind: 'component', type: 'service' } });
  });

  it('a cancelled pinch on a ghost does nothing', () => {
    const { adapter, sent, rejected } = setup();
    adapter.down(44, 22);
    adapter.cancel(44, 22);
    adapter.up(44, 22);
    expect(sent).toEqual([]);
    expect(rejected).toEqual([]);
  });
});
