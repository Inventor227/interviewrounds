// Board model helpers: an empty board, item geometry and hit testing, ids.
// Units are board centimetres, origin top-left, x right, y down (board.v1.schema.json).
import type { Board, BoardItem, BoardKit, ComponentType } from '../shared/types';

export type Pt = [number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The sheet on the desk: 64 x 40 cm. */
export const SHEET = { w: 64, h: 40 } as const;

/** Default footprint of a component card. */
export const CARD = { w: 8, h: 5 } as const;

export function emptyBoard(opts: { id?: string; kit?: BoardKit; question?: string; lines?: string[] } = {}): Board {
  const kit = opts.kit ?? 'hld';
  return {
    schema: 'ir.board.v1',
    round: { id: opts.id ?? 'dev', type: kit, question_id: null, language: null },
    rev: 0,
    size: { w: SHEET.w, h: SHEET.h },
    brief: { question: opts.question ?? '', lines: opts.lines ?? [] },
    items: [],
    edges: [],
    code: null,
    meeting: null,
    focus: null,
    ghosts: [],
    op_ids: [],
  };
}

/** Footprint of an item, with the schema defaults for optional sizes. Ink uses its bounds. */
export function itemRect(item: BoardItem): Rect {
  switch (item.kind) {
    case 'component':
    case 'class':
    case 'group':
      return { x: item.x, y: item.y, w: item.w, h: item.h };
    case 'sticky':
      return { x: item.x, y: item.y, w: item.w ?? 7, h: item.h ?? 7 };
    case 'metric':
      return { x: item.x, y: item.y, w: item.w ?? 10, h: item.h ?? 4 };
    case 'interviewer_card':
      return { x: item.x, y: item.y, w: item.w ?? 14, h: item.h ?? 8 };
    case 'ink':
      return bounds(item.points);
  }
}

export function bounds(points: readonly Pt[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function inRect(r: Rect, x: number, y: number, margin = 0): boolean {
  return x >= r.x - margin && x <= r.x + r.w + margin && y >= r.y - margin && y <= r.y + r.h + margin;
}

/** Distance from a point to a rectangle (0 inside). */
export function distToRect(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export function center(r: Rect): Pt {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

/** Items a stroke or a connector can attach to: everything but ink. */
export function isNode(item: BoardItem): boolean {
  return item.kind !== 'ink';
}

/** Cards you can pick up and move: not ink (it cannot move), not groups (regions behind cards). */
export function isCard(item: BoardItem): boolean {
  return item.kind !== 'ink' && item.kind !== 'group';
}

/** Cards with a pull tab for connecting. */
export function hasTab(item: BoardItem): boolean {
  return item.kind === 'component' || item.kind === 'class' || item.kind === 'metric' || item.kind === 'sticky';
}

/** Centre of an item's pull tab: its top-right corner. */
export function tabCenter(item: BoardItem): Pt {
  const r = itemRect(item);
  return [r.x + r.w, r.y];
}

/** Distance from a point to a polyline. */
export function distToPolyline(points: readonly Pt[], x: number, y: number): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(points[0]![0] - x, points[0]![1] - y);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = distToSegment(points[i - 1]!, points[i]!, x, y);
    if (d < best) best = d;
  }
  return best;
}

export function distToSegment(a: Pt, b: Pt, x: number, y: number): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len2));
  return Math.hypot(a[0] + t * vx - x, a[1] + t * vy - y);
}

/**
 * The node under a point, topmost first (later items draw on top). Groups only when no
 * other node is there. `margin` grows every footprint.
 */
export function nodeAt(board: Board, x: number, y: number, margin = 0, exclude?: string): BoardItem | null {
  let group: BoardItem | null = null;
  for (let i = board.items.length - 1; i >= 0; i--) {
    const it = board.items[i]!;
    if (!isNode(it) || it.id === exclude) continue;
    if (!inRect(itemRect(it), x, y, margin)) continue;
    if (it.kind === 'group') group ??= it;
    else return it;
  }
  return group;
}

/** The nearest non-group node within `radius` cm of a point (0 = inside). */
export function nearestNode(board: Board, x: number, y: number, radius: number, exclude?: string): BoardItem | null {
  let best: BoardItem | null = null;
  let bestD = Infinity;
  for (let i = board.items.length - 1; i >= 0; i--) {
    const it = board.items[i]!;
    if (!isNode(it) || it.kind === 'group' || it.id === exclude) continue;
    const d = distToRect(itemRect(it), x, y);
    if (d <= radius && d < bestD) {
      best = it;
      bestD = d;
    }
  }
  return best;
}

export function findItem(board: Board, id: string | null | undefined): BoardItem | undefined {
  if (!id) return undefined;
  return board.items.find((i) => i.id === id);
}

export const snap = (v: number, grid = 1): number => Math.round(v / grid) * grid;

export function onSheet(board: Board, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= board.size.w && y <= board.size.h;
}

/** Keeps a w x h footprint inside the sheet. */
export function clampToSheet(board: Board, x: number, y: number, w: number, h: number): Pt {
  return [Math.min(Math.max(0, x), Math.max(0, board.size.w - w)), Math.min(Math.max(0, y), Math.max(0, board.size.h - h))];
}

/**
 * Unique ids for ops and items. Ids are never reused after a delete, so they carry a
 * random per-session prefix plus a counter.
 */
export class IdGen {
  private n = 0;
  constructor(private readonly prefix = `h${Math.random().toString(36).slice(2, 6)}`) {}
  next(kind: 'op' | 'item' | 'edge'): string {
    this.n += 1;
    const tag = kind === 'op' ? 'o' : kind === 'edge' ? 'e' : 'n';
    return `${this.prefix}${tag}${this.n}`;
  }
}

/** Display names for component types (cards, tray, the unlabelled placeholder). */
export const COMPONENT_NAMES: Record<ComponentType, string> = {
  client: 'Client',
  lb: 'Load balancer',
  api_gateway: 'API gateway',
  service: 'Service',
  db: 'SQL DB',
  kv: 'NoSQL / KV',
  cache: 'Cache',
  queue: 'Queue',
  cdn: 'CDN',
  object_store: 'Object store',
  search: 'Search index',
  worker: 'Worker',
  external: 'External',
  note: 'Note',
  blank: 'Box',
};
