import { describe, expect, it } from 'vitest';
import type { Board, BoardEdge, GhostOp } from '../shared/types';
import { emptyBoard } from './model';
import { ACCENT, BoardView, renderBoard } from './render';

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
});
