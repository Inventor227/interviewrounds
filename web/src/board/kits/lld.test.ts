import { describe, expect, it } from 'vitest';
import type { Board, BoardOp, ClassItem } from '../../shared/types';
import { BoardInput } from '../input';
import { classLayout, edgeMid, emptyBoard } from '../model';
import { BoardStore } from '../ops';
import { FakeAdapter, roughBox } from '../testkit';
import { LLD_KIT } from './lld';
import { classSignature, describeClass } from './summary';

const LOT: ClassItem = {
  id: 'c1',
  kind: 'class',
  label: 'ParkingLot',
  class_kind: 'class',
  fields: [{ id: 'c1_f1', vis: '-', name: 'levels', type: 'List<Level>' }],
  methods: [{ id: 'c1_m1', vis: '+', name: 'park', params: [{ name: 'v', type: 'Vehicle' }], returns: 'Ticket' }],
  x: 6,
  y: 6,
  w: 14,
  h: 7,
};
const LEVEL: ClassItem = { id: 'c2', kind: 'class', label: 'Level', class_kind: 'abstract', fields: [], methods: [], x: 34, y: 6, w: 14, h: 7 };

describe('LLD summary text (as server/src/board/summary.rs prints it)', () => {
  it('lld_summary_prints_signature', () => {
    expect(classSignature(LOT)).toBe('ParkingLot{-levels:List<Level>; +park(v:Vehicle):Ticket}');
    expect(describeClass(LOT)).toBe('c1 "ParkingLot{-levels:List<Level>; +park(v:Vehicle):Ticket}"');
    expect(describeClass(LEVEL)).toBe('c2 abstract "Level{}"');
    expect(describeClass({ ...LEVEL, label: null, class_kind: 'interface' })).toBe('c2 interface "(unnamed){}"');
  });
});

function setup(items: Board['items'] = [LOT, LEVEL]) {
  const store = new BoardStore({ ...emptyBoard({ kit: 'lld' }), items });
  const adapter = new FakeAdapter();
  const emitted: BoardOp[] = [];
  new BoardInput(store, adapter, LLD_KIT, (op) => {
    emitted.push(op);
    store.apply(op, { local: true });
  });
  return { store, adapter, emitted };
}

describe('LLD kit', () => {
  it('pulls a class, an interface and a note from the tray', () => {
    const { adapter, emitted } = setup([]);
    const slot = (name: string) => LLD_KIT.tray.find((s) => s.name === name)!;
    for (const [name, at] of [['Class', [20, 20]], ['Interface', [40, 20]], ['Note', [30, 34]]] as const) {
      const s = slot(name);
      adapter.stroke([[s.x + 2, s.y + 1], [10, 20], at as [number, number]]);
    }
    expect(emitted.map((o) => o.args)).toMatchObject([
      { kind: 'class', class_kind: 'class', label: null, fields: [], methods: [], w: 14 },
      { kind: 'class', class_kind: 'interface' },
      { kind: 'sticky', lane: null, text: '' },
    ]);
  });

  it('a rough box drawn on the sheet becomes a class card', () => {
    const { emitted, adapter } = setup([]);
    adapter.stroke(roughBox(20, 20, 14, 8, 0.4, 2));
    expect(emitted[0]).toMatchObject({ op: 'item.create', args: { kind: 'class', class_kind: 'class' } });
  });

  it('a member row dragged to another class moves it; onto the bin removes it; a tap selects the class', () => {
    const { store, adapter, emitted } = setup();
    const row = (id: string) => {
      const c = store.board.items.find((i) => i.kind === 'class' && [...i.fields, ...i.methods].some((m) => m.id === id)) as ClassItem;
      return classLayout(c).rows.find((r) => r.member.id === id)!.rect;
    };
    const f = row('c1_f1');
    adapter.down(f.x + 3, f.y + f.h / 2);
    adapter.up(f.x + 3, f.y + f.h / 2);
    expect(emitted).toEqual([]);
    expect(store.board.focus).toBe('c1');
    adapter.stroke([[f.x + 3, f.y + f.h / 2], [25, 10], [40, 10]]);
    expect(emitted[0]).toMatchObject({ op: 'member.move', args: { id: 'c1_f1', to_class_id: 'c2' } });
    const m = row('c1_m1');
    const bin = LLD_KIT.bin;
    adapter.stroke([[m.x + 3, m.y + m.h / 2], [40, 30], [bin.x + 2, bin.y + 2]]);
    expect(emitted[1]).toMatchObject({ op: 'member.remove', args: { id: 'c1_m1' } });
  });

  it('connects classes with a "uses" relation; tapping the chip steps the relation', () => {
    const { store, adapter, emitted } = setup();
    // The c1 tab sits just outside its top-right corner (20.5, 5.5).
    adapter.stroke([[20.5, 5.5], [28, 8], [36, 9]]);
    expect(emitted[0]).toMatchObject({ op: 'edge.create', args: { from: 'c1', to: 'c2', rel: 'uses' } });
    // The relation pill at the midpoint between the card centres.
    const [mx, my] = edgeMid(store.board, store.board.edges[0]!)!;
    adapter.down(mx, my);
    adapter.up(mx, my);
    expect(emitted[1]).toMatchObject({ op: 'edge.set_rel', args: { rel: 'has_a' } });
  });
});
