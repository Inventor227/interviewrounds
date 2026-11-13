// Board input: one state machine per hand, driven by a PointerAdapter in board cm.
// Pinch (or mouse button) on a card drags it, on its tab connects it, on the tray pulls
// a new card, on empty sheet draws ink that the recognizer may turn into a card or an
// edge. Input never applies ops itself: it emits them, and the caller applies them
// locally (optimistically) and sends them on.
import type { Board, BoardEdge, BoardItem, BoardOp, ComponentType } from '../shared/types';
import { StrokeBuilder } from './ink';
import { traySlotAt, type Kit } from './kits';
import {
  clampToSheet,
  distToPolyline,
  edgeMid,
  findItem,
  hasTab,
  IdGen,
  inRect,
  isCard,
  itemRect,
  nearestNode,
  onSheet,
  snap,
  tabCenter,
  type Pt,
} from './model';
import type { BoardStore } from './ops';
import { recognize } from './recognize';

export type Hand = 'left' | 'right' | 'mouse';

/** A pointer sample on the board plane, in board cm. */
export interface BoardPoint {
  x_cm: number;
  y_cm: number;
  t_ms: number;
  hand: Hand;
}

/** Pinch down / move / release, already projected onto the board. Each returns an unsubscribe. */
export interface PointerAdapter {
  onDown(cb: (p: BoardPoint) => void): () => void;
  onMove(cb: (p: BoardPoint) => void): () => void;
  onUp(cb: (p: BoardPoint) => void): () => void;
  /**
   * The gesture was lost (pointer cancel, hand tracking lost past its grace time): drop it
   * with no op. Optional; the point is the last good position.
   */
  onCancel?(cb: (p: BoardPoint) => void): () => void;
}

/** Movement before a press becomes a drag (research 06 §1.1). */
export const DRAG_THRESHOLD_CM = 1.5;
/** A connector snaps to a card within this distance. */
export const MAGNET_CM = 4;
/** Hit radius around a card's pull tab: hand sized (research 06 §2.3: a 2.4 cm tab, 2.0 cm hit). */
export const TAB_HIT_CM = 2.0;
/** Hit radius around an edge's midpoint chip (hand sized). */
export const CHIP_HIT_CM = 2.2;
/** Drawn radius of the tab and the chip (render.ts, hand size): inside another card's core only these count. */
export const TAB_DRAWN_CM = 1.2;
export const CHIP_DRAWN_CM = 1.1;
/** Half size of an edge label pill, the target of a labelled edge. */
const LABEL_PILL_HALF_W_CM = 3;
const LABEL_PILL_HALF_H_CM = 0.8;
/** Hit distance from an ink stroke, for picking it up. */
export const INK_HIT_CM = 0.5;
/**
 * Ink is picked up only after a pinch-hold: still (within INK_HOLD_STILL_CM) for INK_HOLD_MS
 * before moving. Otherwise a stroke that starts on or near ink draws new ink.
 */
export const INK_HOLD_MS = 300;
export const INK_HOLD_STILL_CM = 0.8;
/**
 * Outer band of a card where a stroke starts as ink instead of a drag, so a line drawn
 * from a card's edge to another card becomes a connection, as on paper.
 */
export const RIM_CM = 0.8;

const DIR_CYCLE: BoardEdge['dir'][] = ['->', '<->', '--'];

/** What the live gesture looks like, for the renderer. */
export type Overlay =
  | { kind: 'none' }
  | { kind: 'ink'; hand: Hand; points: Pt[] }
  | { kind: 'drag'; hand: Hand; id: string; dx: number; dy: number; overBin: boolean; ink: boolean }
  | { kind: 'connect'; hand: Hand; from: string; x: number; y: number; target: string | null }
  | { kind: 'tray'; hand: Hand; type: ComponentType; x: number; y: number; onSheet: boolean; overBin: boolean };

type Gesture =
  | { kind: 'press'; id: string; start: Pt; target: 'item' | 'edge' }
  | { kind: 'drag'; id: string; start: Pt; target: 'item' | 'edge'; dx: number; dy: number; overBin: boolean; ink?: boolean }
  | { kind: 'connect'; from: string; x: number; y: number; target: string | null }
  | { kind: 'tray'; type: ComponentType; x: number; y: number; onSheet: boolean; overBin: boolean }
  | { kind: 'ink'; stroke: StrokeBuilder; grab: { id: string; start: Pt; t0: number } | null };

export interface BoardInputOptions {
  ids?: IdGen;
  /** Clock for focus timestamps (ms). */
  now?: () => number;
  /** One Euro filter ink from hands here (off when the hand adapter filters upstream). */
  filterHands?: boolean;
}

export class BoardInput {
  private gestures = new Map<Hand, Gesture>();
  private listeners = new Set<(o: Overlay) => void>();
  private offs: (() => void)[];
  private readonly ids: IdGen;
  private readonly now: () => number;
  /** The card under an idle pointer (mouse hover), for highlighting. */
  hover: string | null = null;

  constructor(
    private readonly store: BoardStore,
    adapter: PointerAdapter,
    private readonly kit: Kit,
    private readonly emit: (op: BoardOp) => void,
    private readonly opts: BoardInputOptions = {},
  ) {
    this.ids = opts.ids ?? new IdGen();
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.offs = [adapter.onDown((p) => this.down(p)), adapter.onMove((p) => this.move(p)), adapter.onUp((p) => this.up(p))];
    if (adapter.onCancel) this.offs.push(adapter.onCancel((p) => this.cancel(p)));
  }

  destroy(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.gestures.clear();
  }

  /** Live overlays, one per active hand. */
  get overlays(): Overlay[] {
    return [...this.gestures.entries()].map(([hand, g]) => toOverlay(hand, g)).filter((o) => o.kind !== 'none');
  }

  /** The first live overlay, or none. */
  get overlay(): Overlay {
    return this.overlays[0] ?? { kind: 'none' };
  }

  onOverlay(cb: (o: Overlay) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    const o = this.overlay;
    for (const cb of [...this.listeners]) cb(o);
  }

  private get board(): Board {
    return this.store.board;
  }

  private op(op: Omit<BoardOp, 'op_id' | 'src'>): void {
    this.emit({ op_id: this.ids.next('op'), src: 'hand', ...op } as BoardOp);
  }

  private focus(id: string | null): void {
    this.store.setFocus(id, this.now());
  }

  // ---------- hit testing ----------

  private hit(x: number, y: number): Gesture | null {
    const b = this.board;
    const slot = traySlotAt(this.kit, x, y);
    if (slot) return { kind: 'tray', type: slot.type, x, y, onSheet: false, overBin: false };

    // The card under the point: its core drags it, its rim draws (so lines from a card's edge connect).
    let core: BoardItem | null = null;
    for (let i = b.items.length - 1; i >= 0; i--) {
      const it = b.items[i]!;
      if (!isCard(it)) continue;
      const r = itemRect(it);
      if (!inRect(r, x, y)) continue;
      const band = Math.min(RIM_CM, 0.2 * Math.min(r.w, r.h));
      if (inRect({ x: r.x + band, y: r.y + band, w: r.w - 2 * band, h: r.h - 2 * band }, x, y)) core = it;
      break;
    }

    // Tabs and chips have hand-sized hit areas, but inside another card's core only their
    // drawn circle counts, so a neighbour's zone never takes that card's presses.
    for (let i = b.items.length - 1; i >= 0; i--) {
      const it = b.items[i]!;
      if (!hasTab(it)) continue;
      const [tx, ty] = tabCenter(it);
      const d = Math.hypot(tx - x, ty - y);
      if (d > TAB_HIT_CM) continue;
      if (core && core.id !== it.id && d > TAB_DRAWN_CM) continue;
      return { kind: 'connect', from: it.id, x, y, target: null };
    }

    for (let i = b.edges.length - 1; i >= 0; i--) {
      const e = b.edges[i]!;
      const m = edgeMid(b, e);
      if (!m) continue;
      // A labelled edge shows a pill instead of a chip: the pill is the target.
      const hitChip = e.label
        ? Math.abs(m[0] - x) <= LABEL_PILL_HALF_W_CM && Math.abs(m[1] - y) <= LABEL_PILL_HALF_H_CM
        : Math.hypot(m[0] - x, m[1] - y) <= (core ? CHIP_DRAWN_CM : CHIP_HIT_CM);
      if (hitChip) return { kind: 'press', id: e.id, start: [x, y], target: 'edge' };
    }

    return core ? { kind: 'press', id: core.id, start: [x, y], target: 'item' } : null;
  }

  /** The topmost ink stroke under a point, a candidate for a pinch-hold pick-up. */
  private inkAt(x: number, y: number): string | null {
    const b = this.board;
    for (let i = b.items.length - 1; i >= 0; i--) {
      const it = b.items[i]!;
      if (it.kind === 'ink' && distToPolyline(it.points, x, y) <= INK_HIT_CM) return it.id;
    }
    return null;
  }

  // ---------- pointer events ----------

  private down(p: BoardPoint): void {
    const { x_cm: x, y_cm: y } = p;
    let g = this.hit(x, y);
    if (!g && onSheet(this.board, x, y)) {
      const stroke = new StrokeBuilder(p.hand, { filter: this.opts.filterHands && p.hand !== 'mouse' });
      stroke.add(x, y, p.t_ms);
      const ink = this.inkAt(x, y);
      g = { kind: 'ink', stroke, grab: ink ? { id: ink, start: [x, y], t0: p.t_ms } : null };
    }
    if (!g) return;
    this.gestures.set(p.hand, g);
    this.hover = null;
    this.changed();
  }

  private move(p: BoardPoint): void {
    const { x_cm: x, y_cm: y } = p;
    const g = this.gestures.get(p.hand);
    if (!g) {
      this.hoverAt(x, y);
      return;
    }
    switch (g.kind) {
      case 'press': {
        if (Math.hypot(x - g.start[0], y - g.start[1]) < DRAG_THRESHOLD_CM) return;
        this.gestures.set(p.hand, { ...g, kind: 'drag', dx: x - g.start[0], dy: y - g.start[1], overBin: inRect(this.kit.bin, x, y) });
        break;
      }
      case 'drag':
        g.dx = x - g.start[0];
        g.dy = y - g.start[1];
        g.overBin = inRect(this.kit.bin, x, y);
        break;
      case 'connect':
        g.x = x;
        g.y = y;
        g.target = nearestNode(this.board, x, y, MAGNET_CM, g.from)?.id ?? null;
        break;
      case 'tray':
        g.x = x;
        g.y = y;
        g.onSheet = onSheet(this.board, x, y);
        g.overBin = inRect(this.kit.bin, x, y);
        break;
      case 'ink': {
        const grab = g.grab;
        if (grab && Math.hypot(x - grab.start[0], y - grab.start[1]) > INK_HOLD_STILL_CM) {
          if (p.t_ms - grab.t0 >= INK_HOLD_MS) {
            // Held still on the stroke first: pick it up (to the bin).
            const [sx, sy] = grab.start;
            this.gestures.set(p.hand, { kind: 'drag', id: grab.id, start: grab.start, target: 'item', dx: x - sx, dy: y - sy, overBin: inRect(this.kit.bin, x, y), ink: true });
            break;
          }
          g.grab = null;
        }
        g.stroke.add(x, y, p.t_ms);
        break;
      }
    }
    this.changed();
  }

  private cancel(p: BoardPoint): void {
    if (this.gestures.delete(p.hand)) this.changed();
  }

  private hoverAt(x: number, y: number): void {
    const b = this.board;
    let id: string | null = null;
    for (let i = b.items.length - 1; i >= 0 && !id; i--) {
      const it = b.items[i]!;
      if (isCard(it) && inRect(itemRect(it), x, y)) id = it.id;
    }
    if (id !== this.hover) {
      this.hover = id;
      this.changed();
    }
  }

  private up(p: BoardPoint): void {
    const g = this.gestures.get(p.hand);
    if (!g) return;
    // Finish with the release position (a press that jumped past the threshold is a drag).
    this.move(p);
    const fin = this.gestures.get(p.hand)!;
    this.gestures.delete(p.hand);
    switch (fin.kind) {
      case 'press':
        this.tap(fin);
        break;
      case 'drag':
        this.drop(fin, p);
        break;
      case 'connect':
        if (fin.target) this.op({ op: 'edge.create', args: { id: this.ids.next('edge'), from: fin.from, to: fin.target, dir: '->' } });
        break;
      case 'tray':
        if (fin.onSheet) this.createCard(fin.type, fin.x - this.kit.card.w / 2, fin.y - this.kit.card.h / 2, this.kit.card.w, this.kit.card.h);
        break;
      case 'ink':
        this.finishStroke(fin.stroke);
        break;
    }
    this.changed();
  }

  private tap(g: Extract<Gesture, { kind: 'press' }>): void {
    if (g.target === 'edge') {
      const e = this.board.edges.find((x) => x.id === g.id);
      if (!e) return;
      const next = DIR_CYCLE[(DIR_CYCLE.indexOf(e.dir) + 1) % DIR_CYCLE.length]!;
      this.op({ op: 'edge.set_dir', args: { id: e.id, dir: next } });
      return;
    }
    const it = findItem(this.board, g.id);
    if (it && it.kind !== 'ink') this.focus(it.id);
  }

  private drop(g: Extract<Gesture, { kind: 'drag' }>, p: BoardPoint): void {
    if (g.target === 'edge') {
      if (g.overBin && this.board.edges.some((e) => e.id === g.id)) this.op({ op: 'edge.delete', args: { id: g.id } });
      return;
    }
    const it = findItem(this.board, g.id);
    if (!it) return;
    if (g.overBin) {
      this.op({ op: 'item.delete', args: { id: it.id } });
      return;
    }
    // Ink cannot move; a card released off the sheet goes back where it was.
    if (it.kind === 'ink' || !onSheet(this.board, p.x_cm, p.y_cm)) return;
    const r = itemRect(it);
    const [x, y] = clampToSheet(this.board, snap(r.x + g.dx), snap(r.y + g.dy), r.w, r.h);
    if (x !== r.x || y !== r.y) this.op({ op: 'item.move', args: { id: it.id, x, y } });
    this.focus(it.id);
  }

  private createCard(type: ComponentType, x: number, y: number, w: number, h: number): void {
    const [cx, cy] = clampToSheet(this.board, snap(x), snap(y), w, h);
    const id = this.ids.next('item');
    const item: BoardItem = { id, kind: 'component', type, label: null, x: cx, y: cy, w, h };
    this.op({ op: 'item.create', args: item });
    this.focus(id);
  }

  private finishStroke(stroke: StrokeBuilder): void {
    const pts = stroke.points();
    const r = recognize(pts, this.board);
    if (!r) {
      // Too short to keep: a tap. On a card's rim it selects the card; on empty sheet it clears focus.
      const [sx, sy] = stroke.live()[0] ?? [NaN, NaN];
      let card: string | null = null;
      for (let i = this.board.items.length - 1; i >= 0 && !card; i--) {
        const it = this.board.items[i]!;
        if (isCard(it) && inRect(itemRect(it), sx, sy)) card = it.id;
      }
      this.focus(card);
      return;
    }
    switch (r.kind) {
      case 'rect':
        this.createCard('service', r.x, r.y, r.w, r.h);
        return;
      case 'circle': {
        const d = snap(2 * r.r);
        const w = Math.max(3, d);
        const h = Math.max(2, d);
        this.createCard('client', r.cx - w / 2, r.cy - h / 2, w, h);
        return;
      }
      case 'connector':
        this.op({ op: 'edge.create', args: { id: this.ids.next('edge'), from: r.from, to: r.to, dir: '->' } });
        return;
      case 'ink':
        this.op({ op: 'item.create', args: { id: this.ids.next('item'), kind: 'ink', points: stroke.inkPoints(), recognized: null } });
        return;
    }
  }
}

function toOverlay(hand: Hand, g: Gesture): Overlay {
  switch (g.kind) {
    case 'press':
      return { kind: 'none' };
    case 'drag':
      return g.target === 'item' ? { kind: 'drag', hand, id: g.id, dx: g.dx, dy: g.dy, overBin: g.overBin, ink: g.ink === true } : { kind: 'none' };
    case 'connect':
      return { kind: 'connect', hand, from: g.from, x: g.x, y: g.y, target: g.target };
    case 'tray':
      return { kind: 'tray', hand, type: g.type, x: g.x, y: g.y, onSheet: g.onSheet, overBin: g.overBin };
    case 'ink':
      return { kind: 'ink', hand, points: g.stroke.live() };
  }
}
