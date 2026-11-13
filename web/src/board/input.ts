// Board input: one state machine per hand, driven by a PointerAdapter in board cm.
// Pinch (or mouse button) on a card drags it, on its tab connects it, on the tray pulls
// a new card, on empty sheet draws ink that the recognizer may turn into a card or an
// edge. Input never applies ops itself: it emits them, and the caller applies them
// locally (optimistically) and sends them on.
import type { Board, BoardEdge, BoardItem, BoardOp, EdgeRel } from '../shared/types';
import { StrokeBuilder } from './ink';
import { traySlotAt, type Kit, type KitContext, type KitDraw, type KitOp, type KitPress, type TrayMake, type TraySlot } from './kits';
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
   * The gesture ended without a release. Optional; the point is the last good position.
   * - no reason: aborted (a pointer cancel): drop it, no op.
   * - 'lost': the hand was lost (tracking gone past its grace, or the pinch was cancelled by
   *   the system). A card or tray card is dropped at the last good point unless that is over
   *   the bin or off the sheet; ink, connectors and taps are dropped with no op.
   */
  onCancel?(cb: (p: BoardPoint, reason?: CancelReason) => void): () => void;
  /** An idle pointer stopped hovering (a hand rose, left the sheet or was lost). Optional. */
  onLeave?(cb: (hand: Hand) => void): () => void;
}

export type CancelReason = 'lost';

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
/** Class diagram relations, in the order a tap on the chip steps through them. */
export const REL_CYCLE: EdgeRel[] = ['uses', 'has_a', 'is_a', 'implements'];

/** Default sizes (cm) of what a tray slot or a drawn shape makes. */
const MAKE_SIZE = { class: { w: 14, h: 7 }, sticky: { w: 7, h: 7 }, metric: { w: 10, h: 4 } } as const;

/** The item a tray slot (or a recognized shape) makes; null for chips. */
export function itemFor(make: TrayMake, id: string, x: number, y: number, w: number, h: number): BoardItem | null {
  switch (make.kind) {
    case 'component':
      return { id, kind: 'component', type: make.type, label: null, x, y, w, h };
    case 'class':
      return { id, kind: 'class', label: null, class_kind: make.class_kind, fields: [], methods: [], x, y, w, h };
    case 'sticky':
      return { id, kind: 'sticky', lane: null, text: '', votes: 0, quad: null, x, y };
    case 'metric':
      return { id, kind: 'metric', role: make.role, label: null, x, y };
    case 'chip':
      return null;
  }
}

/** Footprint of what a make produces, given the kit's card size for components. */
export function makeSize(make: TrayMake, kit: Kit): { w: number; h: number } {
  if (make.kind === 'component') return kit.card;
  if (make.kind === 'chip') return { w: 6, h: 2.4 };
  return MAKE_SIZE[make.kind];
}

/** What the live gesture looks like, for the renderer. */
export type Overlay =
  | { kind: 'none' }
  | { kind: 'ink'; hand: Hand; points: Pt[] }
  | { kind: 'drag'; hand: Hand; id: string; dx: number; dy: number; overBin: boolean; ink: boolean }
  | { kind: 'connect'; hand: Hand; from: string; x: number; y: number; target: string | null }
  | { kind: 'tray'; hand: Hand; slot: TraySlot; x: number; y: number; onSheet: boolean; overBin: boolean }
  /** A kit's own gesture (a code line, a member row, a number card), drawn by the kit. */
  | { kind: 'kit'; hand: Hand; draw: KitDraw };

type Gesture =
  | { kind: 'press'; id: string; start: Pt; target: 'item' | 'edge' }
  | { kind: 'drag'; id: string; start: Pt; target: 'item' | 'edge'; dx: number; dy: number; overBin: boolean; ink?: boolean }
  | { kind: 'connect'; from: string; x: number; y: number; target: string | null }
  | { kind: 'tray'; slot: TraySlot; x: number; y: number; onSheet: boolean; overBin: boolean }
  | { kind: 'kit'; press: KitPress }
  | { kind: 'ink'; stroke: StrokeBuilder; grab: { id: string; start: Pt; t0: number } | null };

export interface BoardInputOptions {
  ids?: IdGen;
  /** Clock for focus timestamps (ms). */
  now?: () => number;
  /** One Euro filter ink from hands here (off when the hand adapter filters upstream). */
  filterHands?: boolean;
  /** Seconds since round start, for ops that carry a time (trace, agenda, shown). Default: since this input started. */
  now_s?: () => number;
}

export class BoardInput {
  private gestures = new Map<Hand, Gesture>();
  private listeners = new Set<(o: Overlay) => void>();
  private offs: (() => void)[];
  private readonly ids: IdGen;
  private readonly now: () => number;
  private readonly now_s: () => number;
  /** The card under each idle pointer (a hovering hand or the mouse), for highlighting. */
  private readonly hoverBy = new Map<Hand, string>();

  constructor(
    private readonly store: BoardStore,
    adapter: PointerAdapter,
    private readonly kit: Kit,
    private readonly emit: (op: BoardOp) => void,
    private readonly opts: BoardInputOptions = {},
  ) {
    this.ids = opts.ids ?? new IdGen();
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const t0 = this.now();
    this.now_s = opts.now_s ?? (() => Math.round((this.now() - t0) / 100) / 10);
    this.offs = [adapter.onDown((p) => this.down(p)), adapter.onMove((p) => this.move(p)), adapter.onUp((p) => this.up(p))];
    if (adapter.onCancel) this.offs.push(adapter.onCancel((p, reason) => this.cancel(p, reason)));
    if (adapter.onLeave) this.offs.push(adapter.onLeave((hand) => this.leave(hand)));
  }

  destroy(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.gestures.clear();
  }

  /** Live overlays, one per active hand. */
  get overlays(): Overlay[] {
    const kitOverlay = this.kit.handler?.overlay ? (p: KitPress) => this.kit.handler!.overlay!(p, this.board, this.kit) : undefined;
    return [...this.gestures.entries()].map(([hand, g]) => toOverlay(hand, g, kitOverlay)).filter((o) => o.kind !== 'none');
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

  private op(op: Omit<BoardOp, 'op_id' | 'src'> | KitOp): void {
    this.emit({ op_id: this.ids.next('op'), src: 'hand', ...op } as BoardOp);
  }

  private ctx(): KitContext {
    return {
      board: this.board,
      kit: this.kit,
      now_s: this.now_s,
      newId: (kind) => this.ids.next(kind === 'line' ? 'item' : kind),
    };
  }

  private focus(id: string | null): void {
    this.store.setFocus(id, this.now());
  }

  // ---------- hit testing ----------

  private hit(x: number, y: number): Gesture | null {
    const b = this.board;
    const slot = traySlotAt(this.kit, x, y);
    if (slot) return { kind: 'tray', slot, x, y, onSheet: false, overBin: false };

    // The kit's own parts (code lines, member rows, agenda rows, number cards) come first.
    const kstate = this.kit.handler?.hit(x, y, this.ctx());
    if (kstate != null) return { kind: 'kit', press: { hand: 'mouse', start: [x, y], x, y, t_ms: 0, state: kstate } };

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
      const hitChip = e.label || e.rel
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
    if (g.kind === 'kit') {
      g.press.hand = p.hand;
      g.press.t_ms = p.t_ms;
    }
    this.gestures.set(p.hand, g);
    this.hoverBy.delete(p.hand);
    this.changed();
  }

  /** The first hovered card, if any. */
  get hover(): string | null {
    return this.hovers()[0] ?? null;
  }

  /** Every hovered card (one per idle hand). */
  hovers(): string[] {
    return [...new Set(this.hoverBy.values())];
  }

  private move(p: BoardPoint): void {
    const { x_cm: x, y_cm: y } = p;
    const g = this.gestures.get(p.hand);
    if (!g) {
      this.hoverAt(p.hand, x, y);
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
      case 'kit': {
        g.press.x = x;
        g.press.y = y;
        g.press.t_ms = p.t_ms;
        for (const op of this.kit.handler?.move?.(g.press, this.ctx()) ?? []) this.op(op);
        break;
      }
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

  private cancel(p: BoardPoint, reason?: CancelReason): void {
    const g = this.gestures.get(p.hand);
    if (!g) return;
    this.gestures.delete(p.hand);
    if (reason === 'lost') {
      // Keep the user's work where they put it, but never delete or create off the sheet on a loss.
      const safe = onSheet(this.board, p.x_cm, p.y_cm) && !inRect(this.kit.bin, p.x_cm, p.y_cm);
      if (g.kind === 'drag' && g.target === 'item' && !g.ink && safe) this.drop({ ...g, overBin: false }, p);
      else if (g.kind === 'tray' && safe) this.trayDrop(g.slot, p.x_cm, p.y_cm);
    }
    this.changed();
  }

  private leave(hand: Hand): void {
    if (this.hoverBy.delete(hand)) this.changed();
  }

  private hoverAt(hand: Hand, x: number, y: number): void {
    const b = this.board;
    let id: string | null = null;
    for (let i = b.items.length - 1; i >= 0 && !id; i--) {
      const it = b.items[i]!;
      if (isCard(it) && inRect(itemRect(it), x, y)) id = it.id;
    }
    if (id === (this.hoverBy.get(hand) ?? null)) return;
    if (id) this.hoverBy.set(hand, id);
    else this.hoverBy.delete(hand);
    this.changed();
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
        if (fin.target) this.connect(fin.from, fin.target);
        break;
      case 'tray':
        this.trayDrop(fin.slot, fin.x, fin.y);
        break;
      case 'kit': {
        const res = this.kit.handler?.up(fin.press, this.ctx());
        for (const op of res?.ops ?? []) this.op(op);
        if (res?.focus !== undefined) this.focus(res.focus);
        break;
      }
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
      if (this.kit.edgeChip === 'rel') {
        const next = e.rel ? REL_CYCLE[(REL_CYCLE.indexOf(e.rel) + 1) % REL_CYCLE.length]! : 'uses';
        this.op({ op: 'edge.set_rel', args: { id: e.id, rel: next } });
        return;
      }
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
    let [x, y] = clampToSheet(this.board, snap(r.x + g.dx), snap(r.y + g.dy), r.w, r.h);
    // The kit may file it somewhere (a sticky's lane or ladder rung) and seat it in that slot.
    const { x: px, y: py, ...filing } = this.kit.place?.(it, p.x_cm, p.y_cm, this.board) ?? {};
    if (px !== undefined) x = px;
    if (py !== undefined) y = py;
    const changed = Object.entries(filing).some(([k, v]) => (it as unknown as Record<string, unknown>)[k] !== v);
    if (x !== r.x || y !== r.y || changed) this.op({ op: 'item.move', args: { id: it.id, x, y, ...filing } });
    this.focus(it.id);
  }

  private connect(from: string, to: string): void {
    const rel = this.kit.defaultRel;
    this.op({ op: 'edge.create', args: { id: this.ids.next('edge'), from, to, dir: '->', ...(rel ? { rel } : {}) } });
  }

  /** A tray card let go at (x, y): the kit's own drop, or the item it makes, centred there. */
  private trayDrop(slot: TraySlot, x: number, y: number): void {
    if (this.kit.trayDrop) {
      const op = this.kit.trayDrop(slot, x, y, this.ctx());
      if (op) {
        this.op(op);
        if (op.op === 'item.create') this.focus(op.args.id);
      }
      return;
    }
    if (!onSheet(this.board, x, y)) return;
    const { w, h } = makeSize(slot.make, this.kit);
    this.createItem(slot.make, x - w / 2, y - h / 2, w, h, [x, y]);
  }

  /** Creates what a make produces at a snapped, on-sheet spot, filed by the kit; focuses it. */
  private createItem(make: TrayMake, x: number, y: number, w: number, h: number, at?: Pt): void {
    const [cx, cy] = clampToSheet(this.board, snap(x), snap(y), w, h);
    const id = this.ids.next('item');
    let item = itemFor(make, id, cx, cy, w, h);
    if (!item) return;
    const [px, py] = at ?? [cx + w / 2, cy + h / 2];
    const placed = this.kit.place?.(item, px, py, this.board);
    if (placed) item = { ...item, ...placed } as BoardItem;
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
      case 'rect': {
        // A drawn box makes the kit's box: a service card, a class card, a sticky.
        const make = this.kit.drawn?.rect === undefined ? ({ kind: 'component', type: 'service' } as TrayMake) : this.kit.drawn.rect;
        if (make) {
          const size = make.kind === 'component' || make.kind === 'class' ? { w: Math.max(r.w, make.kind === 'class' ? 10 : r.w), h: Math.max(r.h, make.kind === 'class' ? 6 : r.h) } : makeSize(make, this.kit);
          this.createItem(make, r.x, r.y, size.w, size.h);
          return;
        }
        break;
      }
      case 'circle': {
        const make = this.kit.drawn?.circle === undefined ? ({ kind: 'component', type: 'client' } as TrayMake) : this.kit.drawn.circle;
        if (make) {
          const d = snap(2 * r.r);
          const w = Math.max(3, d);
          const h = Math.max(2, d);
          this.createItem(make, r.cx - w / 2, r.cy - h / 2, w, h);
          return;
        }
        break;
      }
      case 'connector':
        this.connect(r.from, r.to);
        return;
      case 'ink':
        break;
    }
    this.op({ op: 'item.create', args: { id: this.ids.next('item'), kind: 'ink', points: stroke.inkPoints(), recognized: null } });
  }
}

function toOverlay(hand: Hand, g: Gesture, kitOverlay?: (p: KitPress) => KitDraw | null): Overlay {
  switch (g.kind) {
    case 'press':
      return { kind: 'none' };
    case 'drag':
      return g.target === 'item' ? { kind: 'drag', hand, id: g.id, dx: g.dx, dy: g.dy, overBin: g.overBin, ink: g.ink === true } : { kind: 'none' };
    case 'connect':
      return { kind: 'connect', hand, from: g.from, x: g.x, y: g.y, target: g.target };
    case 'tray':
      return { kind: 'tray', hand, slot: g.slot, x: g.x, y: g.y, onSheet: g.onSheet, overBin: g.overBin };
    case 'kit': {
      const draw = kitOverlay?.(g.press);
      return draw ? { kind: 'kit', hand, draw } : { kind: 'none' };
    }
    case 'ink':
      return { kind: 'ink', hand, points: g.stroke.live() };
  }
}
