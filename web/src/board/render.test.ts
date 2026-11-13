import { describe, expect, it } from 'vitest';
import type { Board, BoardEdge, GhostOp } from '../shared/types';
import { emptyBoard } from './model';
import type { Overlay } from './input';
import { HLD_KIT } from './kits';
import { ACCENT, BoardView, renderBoard, renderOverlay } from './render';

interface Call {
  name: string;
  args: unknown[];
  state: Record<string, unknown>;
}

/** A 2D context stand-in that records every call with the style state at that moment. */
function recorder() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1, font: '10px sans-serif' };
  const stack: Record<string, unknown>[] = [];
  let dash: number[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in state) return state[prop];
        if (prop === 'canvas') return { width: 800, height: 500 };
        return (...args: unknown[]) => {
          calls.push({ name: prop, args, state: { ...state, dash } });
          if (prop === 'save') stack.push({ ...state, __dash: dash });
          if (prop === 'restore') {
            const s = stack.pop();
            if (s) {
              dash = s.__dash as number[];
              delete s.__dash;
              Object.assign(state, s);
            }
          }
          if (prop === 'setLineDash') dash = args[0] as number[];
          if (prop === 'getLineDash') return dash;
          if (prop === 'measureText') {
            const px = Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10);
            return { width: String(args[0]).length * px * 0.55 };
          }
          if (prop === 'createLinearGradient' || prop === 'createPattern') return { addColorStop() {} };
          return undefined;
        };
      },
      set(_t, prop: string, value) {
        state[prop] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function hld(edges: BoardEdge[] = [], ghosts: GhostOp[] = []): Board {
  return {
    ...emptyBoard(),
    items: [
      { id: 'n1', kind: 'component', type: 'client', label: 'Mobile app', x: 4, y: 18, w: 8, h: 5 },
      { id: 'n2', kind: 'component', type: 'db', label: null, x: 24, y: 18, w: 8, h: 5, notes: ['sharded'] },
      { id: 'i1', kind: 'ink', points: [[40, 30], [44, 31], [46, 29]], recognized: null },
    ],
    edges,
    ghosts,
    focus: 'n1',
  };
}

const edge = (dir: BoardEdge['dir'], label: string | null = null): BoardEdge => ({ id: 'e1', from: 'n1', to: 'n2', dir, label, rel: null });

describe('renderBoard', () => {
  it('draws labels, the type name when unlabelled, and notes', () => {
    const { ctx, calls } = recorder();
    renderBoard(ctx, hld([edge('->', 'HTTPS')]), { pxPerCm: 12 });
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
    expect(texts).toContain('Mobile app');
    expect(texts.some((t) => /SQL DB|Database/i.test(t))).toBe(true);
    expect(texts).toContain('HTTPS');
    expect(texts.some((t) => t.includes('sharded'))).toBe(true);
  });

  it('uses a label font of at least 1.1 cm line height equivalent', () => {
    const { ctx, calls } = recorder();
    renderBoard(ctx, hld(), { pxPerCm: 20 });
    const label = calls.find((c) => c.name === 'fillText' && c.args[0] === 'Mobile app')!;
    const px = Number(/([\d.]+)px/.exec(String(label.state.font))![1]);
    // Line height is 1.3 x the font size.
    expect(px * 1.3).toBeGreaterThanOrEqual(1.1 * 20 - 0.01);
  });

  it('draws the focus ring in the accent colour', () => {
    const { ctx, calls } = recorder();
    renderBoard(ctx, hld(), { pxPerCm: 12 });
    expect(calls.some((c) => c.name === 'stroke' && String(c.state.strokeStyle).toUpperCase() === ACCENT.toUpperCase())).toBe(true);
  });

  it('draws arrowheads for -> and <->, none for --', () => {
    const fills = (dir: BoardEdge['dir']) => {
      const { ctx, calls } = recorder();
      renderBoard(ctx, hld([edge(dir)]), { pxPerCm: 12 });
      return calls.filter((c) => c.name === 'fill' && c.state.fillStyle === c.state.strokeStyle).length;
    };
    const none = fills('--');
    expect(fills('->')).toBe(none + 1);
    expect(fills('<->')).toBe(none + 2);
  });

  it('draws ink with round caps', () => {
    const { ctx, calls } = recorder();
    renderBoard(ctx, hld(), { pxPerCm: 12 });
    expect(calls.some((c) => c.name === 'stroke' && c.state.lineCap === 'round')).toBe(true);
  });

  it('draws ghosts at 40% with a dashed outline', () => {
    const ghosts: GhostOp[] = [
      { op_id: 'g1', src: 'scribe', op: 'item.create', args: { id: 'n3', kind: 'component', type: 'cache', label: 'Redis', x: 24, y: 6, w: 8, h: 5 } },
      { op_id: 'g2', src: 'scribe', op: 'edge.create', args: { id: 'e9', from: 'n2', to: 'n1' } },
    ];
    const { ctx, calls } = recorder();
    renderBoard(ctx, hld([], ghosts), { pxPerCm: 12 });
    const ghostStrokes = calls.filter((c) => c.name === 'stroke' && c.state.globalAlpha === 0.4);
    expect(ghostStrokes.length).toBeGreaterThanOrEqual(2);
    expect(ghostStrokes.some((c) => (c.state.dash as number[]).length > 0)).toBe(true);
    expect(calls.some((c) => c.name === 'fillText' && c.args[0] === 'Redis' && c.state.globalAlpha === 0.4)).toBe(true);
  });

  it('marks the highlighted item', () => {
    const base = recorder();
    renderBoard(base.ctx, hld(), { pxPerCm: 12 });
    const hi = recorder();
    renderBoard(hi.ctx, hld(), { pxPerCm: 12, highlight: 'n2' });
    expect(hi.calls.filter((c) => c.name === 'stroke').length).toBeGreaterThan(base.calls.filter((c) => c.name === 'stroke').length);
  });

  it('renders every item kind without throwing', () => {
    const { ctx } = recorder();
    const b: Board = {
      ...emptyBoard(),
      items: [
        { id: 'c1', kind: 'class', label: 'Lot', class_kind: 'abstract', fields: [{ id: 'f1', vis: '-', name: 'levels', type: 'List<Level>' }], methods: [{ id: 'm1', vis: '+', name: 'park', params: [{ name: 'v', type: 'Vehicle' }], returns: 'Ticket' }], x: 2, y: 2, w: 14, h: 12 },
        { id: 's1', kind: 'sticky', lane: 'pain', text: 'Cannot find parking', votes: 2, quad: null, x: 20, y: 2 },
        { id: 'g1', kind: 'group', label: 'write path', x: 30, y: 2, w: 20, h: 14 },
        { id: 'm1', kind: 'metric', role: 'north_star', label: 'Weekly riders', x: 30, y: 20 },
        { id: 'k1', kind: 'interviewer_card', title: 'Signal', body: 'Checkout down 8% since Tuesday', x: 2, y: 24 },
        ...(['client', 'lb', 'api_gateway', 'service', 'db', 'kv', 'cache', 'queue', 'cdn', 'object_store', 'search', 'worker', 'external', 'note', 'blank'] as const).map(
          (type, i) => ({ id: `t${i}`, kind: 'component' as const, type, label: type, x: (i % 8) * 8, y: 30 + Math.floor(i / 8) * 5, w: 7, h: 4 }),
        ),
      ],
    };
    expect(() => renderBoard(ctx, b, { pxPerCm: 10 })).not.toThrow();
  });
});

describe('BoardView', () => {
  it('redraws only when the board, highlight or overlay changed', () => {
    const { ctx, calls } = recorder();
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const view = new BoardView(canvas, { pxPerCm: 10, originCm: { x: -14, y: 0 }, widthCm: 88, heightCm: 40, layerFactory: () => null });
    const b = hld();
    expect(view.draw(b)).toBe(true);
    const n = calls.length;
    expect(view.draw(b)).toBe(false);
    expect(calls.length).toBe(n);
    expect(view.draw(b, { highlight: 'n2' })).toBe(true);
    expect(view.draw({ ...b, rev: 1 }, { highlight: 'n2' })).toBe(true);
  });

  function layered() {
    const main = recorder();
    const layers: ReturnType<typeof recorder>[] = [];
    const canvas = { width: 0, height: 0, getContext: () => main.ctx } as unknown as HTMLCanvasElement;
    const view = new BoardView(canvas, {
      pxPerCm: 10,
      originCm: { x: -14, y: 0 },
      widthCm: 88,
      heightCm: 40,
      kit: HLD_KIT,
      layerFactory: () => {
        const r = recorder();
        layers.push(r);
        return { width: 880, height: 400, getContext: () => r.ctx } as unknown as HTMLCanvasElement;
      },
    });
    const layerCalls = () => layers.reduce((n, l) => n + l.calls.length, 0);
    const texts = (calls: Call[]) => calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
    return { main, layers, view, layerCalls, texts };
  }

  it('during a stroke only the live layer is drawn: the board layer is reused', () => {
    const { main, view, layerCalls, texts } = layered();
    const b = hld();
    view.draw(b);
    const l0 = layerCalls();
    const m0 = main.calls.length;
    const ink: Overlay = { kind: 'ink', hand: 'mouse', points: [[40, 10], [42, 11], [44, 10]] };
    expect(view.draw(b, { overlays: [ink] })).toBe(true);
    const fresh = main.calls.slice(m0);
    expect(layerCalls()).toBe(l0);
    expect(fresh.some((c) => c.name === 'drawImage')).toBe(true);
    expect(texts(fresh)).toEqual([]);
    expect(fresh.some((c) => c.name === 'stroke' && c.state.lineCap === 'round')).toBe(true);
    // Only the stroke's area changed.
    expect(view.dirty!.w).toBeLessThan(880);
    expect(view.dirty!.h).toBeLessThan(400);
  });

  it('a drag repaints the board layer once without the dragged card, then only the card moves', () => {
    const { main, layers, view, layerCalls, texts } = layered();
    const b = hld([edge('->')]);
    view.draw(b);
    const drag = (dx: number): Overlay => ({ kind: 'drag', hand: 'mouse', id: 'n1', dx, dy: 0, overBin: false, ink: false });
    const l0 = layerCalls();
    const before = layers[1]!.calls.length;
    view.draw(b, { overlays: [drag(2)] });
    expect(layerCalls()).toBeGreaterThan(l0);
    const repaint = texts(layers[1]!.calls.slice(before));
    expect(repaint).toContain('Unnamed');
    expect(repaint).not.toContain('Mobile app');
    const l1 = layerCalls();
    const m1 = main.calls.length;
    view.draw(b, { overlays: [drag(3)] });
    expect(layerCalls()).toBe(l1);
    const live = texts(main.calls.slice(m1));
    expect(live).toContain('Mobile app');
    expect(live).not.toContain('Unnamed');
  });

  it('repaints the static layer when the framing changes at the same pixel size', () => {
    const { layers, view } = layered();
    const b = hld();
    view.draw(b);
    const n = layers.length;
    view.configure({ originCm: { x: -10, y: 0 } });
    view.draw(b);
    expect(layers.length).toBeGreaterThan(n);
  });
});

describe('overlays, ghosts and targets', () => {
  it('dims ink being dragged unless it is over the bin (ink cannot move)', () => {
    const b = hld();
    const alphaOfInk = (overBin: boolean) => {
      const { ctx, calls } = recorder();
      renderOverlay(ctx, b, { kind: 'drag', hand: 'mouse', id: 'i1', dx: 5, dy: 0, overBin, ink: true }, HLD_KIT, 10);
      return calls.find((c) => c.name === 'stroke' && c.state.lineCap === 'round')!.state.globalAlpha;
    };
    expect(alphaOfInk(false)).toBe(0.45);
    expect(alphaOfInk(true)).toBe(1);
  });

  it('shows ghosts of moves, deletes, type and arrow changes with a verb', () => {
    const ghosts: GhostOp[] = [
      { op_id: 'g1', src: 'scribe', op: 'item.move', args: { id: 'n1', x: 40, y: 2 } },
      { op_id: 'g2', src: 'scribe', op: 'item.delete', args: { id: 'n2' } },
      { op_id: 'g3', src: 'scribe', op: 'item.set_type', args: { id: 'n1', type: 'cache' } },
      { op_id: 'g4', src: 'scribe', op: 'edge.set_dir', args: { id: 'e1', dir: '<->' } },
    ];
    const { ctx, calls } = recorder();
    renderBoard(ctx, hld([edge('->')], ghosts), { pxPerCm: 10 });
    const texts = calls.filter((c) => c.name === 'fillText' && c.state.globalAlpha === 0.4).map((c) => String(c.args[0]));
    expect(texts).toEqual(expect.arrayContaining(['Move here', 'Delete', 'Make it Cache', 'Arrow <->']));
  });

  it('draws the tab at hand size by default, smaller for the mouse', () => {
    const tabArc = (targets?: 'hand' | 'mouse') => {
      const { ctx, calls } = recorder();
      renderBoard(ctx, hld(), { pxPerCm: 10, targets });
      // n1 is at 4,18 8x5: its tab sits at (12.5, 17.5).
      return calls.find((c) => c.name === 'arc' && Math.abs((c.args[0] as number) - 125) < 0.01 && Math.abs((c.args[1] as number) - 175) < 0.01)?.args[2];
    };
    expect(tabArc()).toBeCloseTo(12);
    expect(tabArc('mouse')).toBeCloseTo(5.5);
  });

  it('caches wrapped labels between frames', () => {
    const count = () => {
      const { ctx, calls } = recorder();
      renderBoard(ctx, hld(), { pxPerCm: 13 });
      return calls.filter((c) => c.name === 'measureText').length;
    };
    const first = count();
    expect(count()).toBeLessThan(first);
  });
});
