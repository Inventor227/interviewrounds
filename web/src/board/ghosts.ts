// Ghosts on the board: Scribe suggestions and local voice suggestions, drawn faded.
// - Pinch a ghost to accept it (the caller sends it as a normal board.op with the same op_id).
// - Pinch-hold it 1 s, or drag it onto the bin, to dismiss it (board.ghost_reject). A slow pinch (well over
//   half a second) still accepts.
// - A Scribe ghost nobody touches settles (is accepted) 4 s after it first shows.
// - A local suggestion (a voice statement like "that's the URL store") never settles: only a
//   pinch accepts it, and untouched it fades away after 8 s. Talk never changes the board.
// GhostLayer sits between a pointer source and BoardInput: pinches that land on a ghost are
// its own, everything else passes through unchanged.
import type { Board, GhostOp } from '../shared/types';
import type { BoardPoint, CancelReason, Hand, PointerAdapter } from './input';
import { DRAG_THRESHOLD_CM } from './input';
import type { Kit } from './kits';
import { bounds, center, edgeMid, findItem, inRect, itemRect, type Pt, type Rect } from './model';
import type { BoardStore } from './ops';

export const GHOST_SETTLE_MS = 4000;
export const GHOST_HOLD_MS = 1000;
/** An untouched local suggestion goes away after this long, without changing the board. */
export const LOCAL_GHOST_FADE_MS = 8000;
/** One slow frame adds at most this much to a pinch-hold, so a hitch never dismisses a ghost. */
const HOLD_FRAME_CAP_MS = 100;
/** Extra reach around a ghost's target, for fingertip error. */
const GHOST_MARGIN_CM = 0.5;

const pill = (at: Pt, w = 6, h = 1.6): Rect => ({ x: at[0] - w / 2, y: at[1] - h / 2, w, h });
const below = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h + 0.9];

/** Board items plus the items ghost creates would add (so a ghost edge to a ghost card has ends). */
function withGhostItems(board: Board): Board {
  const extra = board.ghosts.filter((g): g is Extract<GhostOp, { op: 'item.create' }> => g.op === 'item.create').map((g) => g.args);
  return extra.length ? { ...board, items: [...board.items, ...extra] } : board;
}

/** Where a ghost can be pinched, in board cm: the same places the renderer draws it. */
export function ghostRect(board0: Board, g: GhostOp): Rect | null {
  const board = withGhostItems(board0);
  switch (g.op) {
    case 'item.create': {
      const r = g.args.kind === 'ink' ? bounds(g.args.points) : itemRect(g.args);
      return { x: r.x, y: r.y, w: Math.max(r.w, 2), h: Math.max(r.h, 2) };
    }
    case 'edge.create': {
      const m = edgeMid(board, g.args);
      return m ? pill(m, 4.4, 4.4) : null;
    }
    case 'group.create':
      return pill([g.args.x + g.args.w / 2, g.args.y + 0.9]);
    case 'item.move': {
      const it = findItem(board, g.args.id);
      if (!it) return null;
      const r = itemRect(it);
      return { ...r, x: g.args.x, y: g.args.y };
    }
    case 'item.label':
    case 'item.note.add':
    case 'item.delete':
    case 'item.set_type':
    case 'sticky.vote':
    case 'sticky.set_quad': {
      const it = findItem(board, g.args.id);
      return it ? pill(below(itemRect(it))) : null;
    }
    case 'edge.label':
    case 'edge.set_dir':
    case 'edge.set_rel':
    case 'edge.delete': {
      const e = board.edges.find((x) => x.id === g.args.id);
      const m = e && edgeMid(board, e);
      return m ? pill([m[0], m[1] + 1.1]) : null;
    }
    default:
      return null;
  }
}

/** The topmost ghost under a point. */
export function ghostAt(board: Board, x: number, y: number): GhostOp | null {
  for (let i = board.ghosts.length - 1; i >= 0; i--) {
    const g = board.ghosts[i]!;
    const r = ghostRect(board, g);
    if (r && inRect(r, x, y, GHOST_MARGIN_CM)) return g;
  }
  return null;
}

export interface GhostRing {
  op_id: string;
  /** Where to draw the settle ring (board cm). */
  x: number;
  y: number;
  /** 0..1 of the 4 s settle. */
  progress: number;
}

export interface GhostLayerOptions {
  /** Accept: apply locally and send the op (same op_id). */
  accept(g: GhostOp): void;
  /** Dismiss: drop locally and send board.ghost_reject (server ghosts only). */
  reject(opId: string): void;
  /** Clock in ms (the XR frame clock). */
  now?: () => number;
  settleMs?: number;
  holdMs?: number;
  /** Local suggestions (never auto-accepted). Default: the store's isLocalGhost. */
  isLocal?: (opId: string) => boolean;
}

type Cb = (p: BoardPoint, reason?: CancelReason) => void;

interface Press {
  opId: string;
  start: Pt;
  /** Time held so far, counted frame by frame (a frame hitch counts at most HOLD_FRAME_CAP_MS). */
  heldMs: number;
  lastMs: number;
  dragged: boolean;
  overBin: boolean;
  done: boolean;
}

export class GhostLayer implements PointerAdapter {
  private readonly subs = { down: new Set<Cb>(), move: new Set<Cb>(), up: new Set<Cb>(), cancel: new Set<Cb>() };
  private readonly leaves = new Set<(hand: Hand) => void>();
  private readonly presses = new Map<Hand, Press>();
  /** Hands whose gesture went through to the board, so their moves are not hovers. */
  private readonly passing = new Set<Hand>();
  private readonly firstSeen = new Map<string, number>();
  private readonly touched = new Set<string>();
  private readonly offs: (() => void)[];
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly holdMs: number;

  constructor(
    source: PointerAdapter,
    private readonly store: BoardStore,
    private readonly kit: Kit,
    private readonly opts: GhostLayerOptions,
  ) {
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.settleMs = opts.settleMs ?? GHOST_SETTLE_MS;
    this.holdMs = opts.holdMs ?? GHOST_HOLD_MS;
    this.offs = [
      source.onDown((p) => this.down(p)),
      source.onMove((p) => this.move(p)),
      source.onUp((p) => this.up(p)),
      store.onChange(() => this.seen()),
    ];
    if (source.onCancel) this.offs.push(source.onCancel((p, reason) => this.cancel(p, reason)));
    if (source.onLeave) this.offs.push(source.onLeave((hand) => [...this.leaves].forEach((cb) => cb(hand))));
    this.seen();
  }

  destroy(): void {
    this.offs.forEach((off) => off());
  }

  onDown(cb: Cb): () => void {
    this.subs.down.add(cb);
    return () => this.subs.down.delete(cb);
  }
  onMove(cb: Cb): () => void {
    this.subs.move.add(cb);
    return () => this.subs.move.delete(cb);
  }
  onUp(cb: Cb): () => void {
    this.subs.up.add(cb);
    return () => this.subs.up.delete(cb);
  }
  onLeave(cb: (hand: Hand) => void): () => void {
    this.leaves.add(cb);
    return () => this.leaves.delete(cb);
  }
  onCancel(cb: Cb): () => void {
    this.subs.cancel.add(cb);
    return () => this.subs.cancel.delete(cb);
  }

  private pass(set: Set<Cb>, p: BoardPoint, reason?: CancelReason): void {
    for (const cb of [...set]) cb(p, reason);
  }

  /** Starts the settle clock for ghosts that just showed; forgets ones that went away. */
  private seen(): void {
    const t = this.now();
    const live = new Set(this.store.board.ghosts.map((g) => g.op_id));
    for (const id of live) if (!this.firstSeen.has(id)) this.firstSeen.set(id, t);
    for (const id of [...this.firstSeen.keys()]) if (!live.has(id)) this.firstSeen.delete(id);
    for (const id of [...this.touched]) if (!live.has(id)) this.touched.delete(id);
  }

  private ghost(opId: string): GhostOp | undefined {
    return this.store.board.ghosts.find((g) => g.op_id === opId);
  }

  private down(p: BoardPoint): void {
    const g = ghostAt(this.store.board, p.x_cm, p.y_cm);
    if (!g) {
      this.passing.add(p.hand);
      this.pass(this.subs.down, p);
      return;
    }
    this.touched.add(g.op_id);
    this.presses.set(p.hand, { opId: g.op_id, start: [p.x_cm, p.y_cm], heldMs: 0, lastMs: this.now(), dragged: false, overBin: false, done: false });
  }

  private move(p: BoardPoint): void {
    const pr = this.presses.get(p.hand);
    if (pr) {
      if (pr.done) return;
      if (Math.hypot(p.x_cm - pr.start[0], p.y_cm - pr.start[1]) >= DRAG_THRESHOLD_CM) pr.dragged = true;
      pr.overBin = inRect(this.kit.bin, p.x_cm, p.y_cm);
      return;
    }
    if (!this.passing.has(p.hand)) {
      // A hand hovering over a ghost has touched it: it waits for an explicit pinch.
      const g = ghostAt(this.store.board, p.x_cm, p.y_cm);
      if (g) this.touched.add(g.op_id);
    }
    this.pass(this.subs.move, p);
  }

  private up(p: BoardPoint): void {
    const pr = this.presses.get(p.hand);
    if (!pr) {
      this.passing.delete(p.hand);
      this.pass(this.subs.up, p);
      return;
    }
    this.presses.delete(p.hand);
    if (pr.done) return;
    const g = this.ghost(pr.opId);
    if (!g) return;
    if (pr.dragged) {
      if (inRect(this.kit.bin, p.x_cm, p.y_cm) || pr.overBin) {
        this.opts.reject(g.op_id);
        return;
      }
      // Let go near where it started: a tap that wobbled, not a drag.
      if (Math.hypot(p.x_cm - pr.start[0], p.y_cm - pr.start[1]) >= DRAG_THRESHOLD_CM) return;
    }
    this.opts.accept(g);
  }

  private cancel(p: BoardPoint, reason?: CancelReason): void {
    if (this.presses.delete(p.hand)) return;
    this.passing.delete(p.hand);
    this.pass(this.subs.cancel, p, reason);
  }

  private holdCheck(pr: Press, nowMs: number): void {
    pr.heldMs += Math.min(HOLD_FRAME_CAP_MS, Math.max(0, nowMs - pr.lastMs));
    pr.lastMs = nowMs;
    if (pr.done || pr.dragged || pr.heldMs < this.holdMs) return;
    pr.done = true;
    if (this.ghost(pr.opId)) this.opts.reject(pr.opId);
  }

  /** Call every frame: pinch-holds and the 4 s settle. */
  update(nowMs = this.now()): void {
    for (const pr of this.presses.values()) this.holdCheck(pr, nowMs);
    const pressed = new Set([...this.presses.values()].map((p) => p.opId));
    for (const g of [...this.store.board.ghosts]) {
      const t0 = this.firstSeen.get(g.op_id);
      if (t0 === undefined || this.touched.has(g.op_id) || pressed.has(g.op_id) || !this.ghost(g.op_id)) continue;
      if (this.local(g.op_id)) {
        if (nowMs - t0 >= LOCAL_GHOST_FADE_MS) this.opts.reject(g.op_id);
      } else if (nowMs - t0 >= this.settleMs) this.opts.accept(g);
    }
  }

  private local(opId: string): boolean {
    return (this.opts.isLocal ?? ((id: string) => this.store.isLocalGhost(id)))(opId);
  }

  /** Settle rings for untouched ghosts, for the renderer. */
  rings(nowMs = this.now()): GhostRing[] {
    const out: GhostRing[] = [];
    for (const g of this.store.board.ghosts) {
      const t0 = this.firstSeen.get(g.op_id);
      // Local suggestions wait for a pinch: no settle ring.
      if (t0 === undefined || this.touched.has(g.op_id) || this.local(g.op_id)) continue;
      const r = ghostRect(this.store.board, g);
      if (!r) continue;
      const [cx] = center(r);
      out.push({ op_id: g.op_id, x: Math.max(r.x + r.w, cx), y: r.y, progress: Math.max(0, Math.min(1, (nowMs - t0) / this.settleMs)) });
    }
    return out;
  }
}
