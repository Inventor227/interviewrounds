import { describe, expect, it } from 'vitest';
import type { BoardOp } from '../shared/types';
import { BoardInput } from './input';
import { HLD_KIT } from './kits';
import { emptyBoard } from './model';
import { BoardStore } from './ops';
import { along, FakeAdapter, roughBox } from './testkit';

function setup() {
  const store = new BoardStore(emptyBoard());
  const seed = (op: BoardOp) => expect(store.apply(op).accepted).toBe(true);
  seed({ op_id: 's1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'client', label: null, x: 10, y: 10, w: 8, h: 5 } });
  seed({ op_id: 's2', src: 'hand', op: 'item.create', args: { id: 'n2', kind: 'component', type: 'service', label: null, x: 30, y: 10, w: 8, h: 5 } });
  const adapter = new FakeAdapter();
  const emitted: BoardOp[] = [];
  const input = new BoardInput(store, adapter, HLD_KIT, (op) => {
    emitted.push(op);
    store.apply(op);
  });
  return { store, adapter, emitted, input };
}

describe('BoardInput', () => {
  it('drag_threshold: a 0.9 cm move is a tap that focuses, not a drag', () => {
    const { store, adapter, emitted } = setup();
    adapter.down(14, 12.5);
    adapter.move(14.5, 12.5);
    adapter.move(14.9, 12.5);
    adapter.up(14.9, 12.5);
    expect(emitted).toEqual([]);
    expect(store.board.focus).toBe('n1');
  });

  it('a drag past 1.5 cm moves the card and snaps it to the 1 cm grid', () => {
    const { store, adapter, emitted } = setup();
    adapter.down(14, 12.5);
    adapter.move(15.6, 12.5);
    adapter.move(18.2, 13.4);
    adapter.up(18.2, 13.4);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ src: 'hand', op: 'item.move', args: { id: 'n1', x: 14, y: 11 } });
    expect(store.board.items[0]).toMatchObject({ x: 14, y: 11 });
    expect(store.board.focus).toBe('n1');
  });

  it('a card dropped off the sheet goes back; dropped on the bin it is deleted', () => {
    const { store, adapter, emitted } = setup();
    adapter.stroke([[14, 12.5], [14, 30], [14, 46]]);
    expect(emitted).toEqual([]);
    const bin = HLD_KIT.bin;
    adapter.stroke([[34, 12.5], [50, 20], [bin.x + bin.w / 2, bin.y + bin.h / 2]]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: 'item.delete', args: { id: 'n2' } });
    expect(store.board.items.map((i) => i.id)).toEqual(['n1']);
  });

  it('pulling a card from the tray creates a component where it is dropped, and focuses it', () => {
    const { store, adapter, emitted } = setup();
    const slot = HLD_KIT.tray.find((s) => s.type === 'db')!;
    adapter.stroke([[slot.x + 2, slot.y + 1], [10, 25], [30, 25.2]]);
    expect(emitted).toHaveLength(1);
    const op = emitted[0]!;
    expect(op).toMatchObject({ op: 'item.create', args: { kind: 'component', type: 'db', label: null, x: 26, y: 23, w: 8, h: 5 } });
    expect(store.board.focus).toBe((op.args as { id: string }).id);
  });

  it('a tray card released off the sheet is discarded', () => {
    const { adapter, emitted } = setup();
    const slot = HLD_KIT.tray[0]!;
    adapter.stroke([[slot.x + 2, slot.y + 1], [slot.x + 3, slot.y + 8]]);
    expect(emitted).toEqual([]);
  });

  it("pulling a card's tab to another card connects them (magnet within 4 cm)", () => {
    const { adapter, emitted } = setup();
    adapter.stroke([[18, 10], [24, 11], [27, 12]]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: 'edge.create', args: { from: 'n1', to: 'n2' } });
    adapter.stroke([[18, 10], [24, 25], [24, 30]]);
    expect(emitted).toHaveLength(1);
  });

  it('a rough box drawn on the sheet becomes a service card with focus', () => {
    const { store, adapter, emitted } = setup();
    adapter.stroke(roughBox(20, 22, 9, 6, 0.5, 2));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: 'item.create', args: { kind: 'component', type: 'service', label: null } });
    const a = emitted[0]!.args as { id: string; x: number; y: number; w: number; h: number };
    expect(Math.abs(a.x - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.w - 9)).toBeLessThanOrEqual(1);
    expect(store.board.focus).toBe(a.id);
  });

  it('a line drawn from the edge of one card to another becomes an edge', () => {
    const { adapter, emitted } = setup();
    adapter.stroke(along([[17.6, 12.5], [32, 12.8]], 0.3));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: 'edge.create', args: { from: 'n1', to: 'n2', dir: '->' } });
  });

  it('other strokes stay ink; short jitter makes no mark', () => {
    const { adapter, emitted } = setup();
    adapter.stroke(along([[5, 30], [8, 33], [11, 30], [14, 33]], 0.3));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: 'item.create', args: { kind: 'ink', recognized: null } });
    const pts = (emitted[0]!.args as { points: number[][] }).points;
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (const [x, y] of pts) {
      expect(Math.round(x! * 10) / 10).toBe(x);
      expect(Math.round(y! * 10) / 10).toBe(y);
    }
    adapter.stroke(along([[40, 30], [40.6, 30.3]], 0.1));
    expect(emitted).toHaveLength(1);
  });

  it('an ink stroke dropped on the bin is erased; elsewhere it stays put', () => {
    const { store, adapter, emitted } = setup();
    adapter.stroke(along([[5, 30], [8, 33], [11, 30], [14, 33]], 0.3));
    const inkId = (emitted[0]!.args as { id: string }).id;
    adapter.stroke([[8, 33], [20, 33], [24, 33]]);
    expect(emitted).toHaveLength(1);
    const bin = HLD_KIT.bin;
    adapter.stroke([[8, 33], [30, 35], [bin.x + 1, bin.y + 1]]);
    expect(emitted[1]).toMatchObject({ op: 'item.delete', args: { id: inkId } });
    expect(store.board.items.find((i) => i.id === inkId)).toBeUndefined();
  });

  it('tapping empty sheet clears focus', () => {
    const { store, adapter } = setup();
    store.setFocus('n1');
    adapter.down(50, 35);
    adapter.up(50, 35);
    expect(store.board.focus).toBeNull();
  });

  it('two hands work at the same time without mixing their gestures', () => {
    const { adapter, emitted } = setup();
    adapter.down(14, 12.5, 'left');
    adapter.down(18, 10, 'right');
    adapter.move(16, 14.5, 'left');
    adapter.move(30, 12, 'right');
    adapter.move(18, 16, 'left');
    adapter.up(31, 12, 'right');
    adapter.up(18, 16, 'left');
    expect(emitted.map((o) => o.op).sort()).toEqual(['edge.create', 'item.move']);
  });

  it('shows the live gesture as an overlay and clears it after', () => {
    const { adapter, input } = setup();
    const seen: string[] = [];
    input.onOverlay((o) => seen.push(o.kind));
    adapter.down(5, 30);
    adapter.move(6, 31);
    adapter.move(8, 31);
    expect(input.overlay.kind).toBe('ink');
    adapter.up(8, 31);
    expect(input.overlay.kind).toBe('none');
    expect(seen).toContain('ink');
  });

  it('stops listening after destroy', () => {
    const { adapter, emitted, input } = setup();
    input.destroy();
    adapter.stroke(roughBox(20, 22, 9, 6, 0.5, 2));
    expect(emitted).toEqual([]);
  });
});
