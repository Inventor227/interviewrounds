// Board kits: what sits around and on the sheet for each round type, in board cm. The tray is
// left of the sheet (negative x) and the bin right of it, so both stay off the drawing area
// (kitFor mirrors them for left-handed users). A kit can also:
// - make other things from its tray (class cards, stickies, metrics, chips dropped on slots),
// - take presses on its own parts first (code lines, member rows, agenda rows, number cards),
// - place dropped items (a sticky dropped in a lane or on a ladder rung),
// - draw its fixed parts on the sheet (lanes, ladder, agenda, slots),
// - pick what an edge chip does (cycle the arrow, or the class relation),
// - have a code panel (a standing screen beside the sheet; a region in board cm here).
import type {
  Board,
  BoardItem,
  BoardKit,
  BoardOpName,
  ClassKind,
  ComponentType,
  EdgeRel,
  Lane,
  MetricRole,
  OpArgsMap,
} from '../shared/types';
import type { Hand } from './input';
import { CARD, COMPONENT_NAMES, SHEET, type Pt, type Rect } from './model';

/** What a tray slot makes. */
export type TrayMake =
  | { kind: 'component'; type: ComponentType }
  | { kind: 'class'; class_kind: ClassKind }
  | { kind: 'sticky' }
  | { kind: 'metric'; role: MetricRole }
  /** A complexity chip, dropped on a Time or Space slot. */
  | { kind: 'chip'; value: string };

export interface TraySlot extends Rect {
  name: string;
  make: TrayMake;
  /** Component slots only (kept for callers that look slots up by component type). */
  type?: ComponentType;
}

/** An op without its envelope (the caller adds op_id and src). */
export type KitOp = { [K in BoardOpName]: { op: K; args: OpArgsMap[K] } }[BoardOpName];

/** A live press on a kit's own part (state is the kit's own). */
export interface KitPress {
  hand: Hand;
  start: Pt;
  x: number;
  y: number;
  state: unknown;
}

export interface KitContext {
  board: Board;
  kit: Kit;
  /** Seconds since round start (trace stamps, agenda ticks, what was shown when). */
  now_s(): number;
  /** A new item, edge or line id. */
  newId(kind: 'item' | 'edge' | 'line'): string;
}

/** The look of a live kit gesture, for the renderer. */
export interface KitDraw {
  /** Changes when the drawing changes (the renderer redraws only then). */
  key: string;
  /** Board cm the drawing touches. */
  bounds: Rect;
  draw(ctx: CanvasRenderingContext2D, board: Board, pxPerCm: number): void;
}

export interface KitHandler {
  /** A press on one of the kit's parts, or null to let the board handle it. */
  hit(x: number, y: number, ctx: KitContext): unknown | null;
  /** The pointer moved; may return ops to send now (a trace marker stepping onto a line). */
  move?(press: KitPress, ctx: KitContext): KitOp[];
  /** The pointer let go: the ops to send, and the item to focus (undefined leaves focus). */
  up(press: KitPress, ctx: KitContext): { ops: KitOp[]; focus?: string | null };
  /** How the live press looks. */
  overlay?(press: KitPress, board: Board): KitDraw | null;
}

export interface Kit {
  id: BoardKit;
  tray: TraySlot[];
  /** Drop a card or a stroke here to delete it. */
  bin: Rect;
  /** Size of a card pulled from the tray. */
  card: { w: number; h: number };
  /** Everything a view should show: tray, sheet, bin and any panel. */
  view: Rect;
  /** Tapping an edge chip cycles the arrow ('dir', default) or the class relation ('rel'). */
  edgeChip?: 'dir' | 'rel';
  /** Relation for edges made by hand (class diagrams). */
  defaultRel?: EdgeRel;
  /** Makes a tray drop: an op (create an item, set a slot), or null when it does not land anywhere. */
  trayDrop?(slot: TraySlot, x: number, y: number, ctx: KitContext): KitOp | null;
  /** Extra item.move fields for an item dropped at (x, y): a sticky's lane and ladder rung. */
  place?(item: BoardItem, x: number, y: number, board: Board): { lane?: Lane | null; rank?: number | null } | null;
  /** The kit's own parts take presses before the board. */
  handler?: KitHandler;
  /** Fixed parts drawn on the sheet under the items (lanes, ladder, agenda, slots, the panel). */
  renderSheet?(ctx: CanvasRenderingContext2D, board: Board, pxPerCm: number): void;
  /** The code panel's region in board cm (coding only). In XR it stands beside the sheet. */
  panel?: Rect;
  /** Draws the code panel at `panel` (board cm; the 2D view, and the XR panel's own canvas). */
  renderPanel?(ctx: CanvasRenderingContext2D, board: Board, pxPerCm: number): void;
  /** What a drawn box or circle becomes (default: a service card, a client card); null keeps it ink. */
  drawn?: { rect?: TrayMake | null; circle?: TrayMake | null };
}

export const SLOT = { x: -12, w: 10, h: 2.6, pitch: 3.0, top: 0.5 } as const;

/** Tray slots down the left of the sheet. */
export function traySlots(entries: { name: string; make: TrayMake }[], pitch: number = SLOT.pitch, h: number = SLOT.h): TraySlot[] {
  return entries.map((e, i) => ({
    ...e,
    ...(e.make.kind === 'component' ? { type: e.make.type } : {}),
    x: SLOT.x,
    y: SLOT.top + i * pitch,
    w: SLOT.w,
    h,
  }));
}

const HLD_TYPES: ComponentType[] = [
  'client', 'lb', 'api_gateway', 'service', 'db', 'kv', 'cache', 'queue', 'cdn', 'object_store', 'search', 'worker', 'external',
];

/** System design: 13 component cards. */
export const HLD_KIT: Kit = {
  id: 'hld',
  tray: traySlots(HLD_TYPES.map((type) => ({ name: COMPONENT_NAMES[type], make: { kind: 'component', type } }))),
  bin: { x: SHEET.w + 2, y: SHEET.h - 7, w: 7, h: 7 },
  card: { w: CARD.w, h: CARD.h },
  view: { x: -13, y: -1, w: SHEET.w + 24, h: SHEET.h + 2 },
};

export function traySlotAt(kit: Kit, x: number, y: number): TraySlot | null {
  return kit.tray.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) ?? null;
}
