// Board kits: the tray of cards and the bin around the sheet, in board cm. The tray sits
// left of the sheet (negative x) and the bin right of it, so both stay off the drawing area.
import type { BoardKit, ComponentType } from '../shared/types';
import { CARD, COMPONENT_NAMES, SHEET, type Rect } from './model';

export interface TraySlot extends Rect {
  type: ComponentType;
  name: string;
}

export interface Kit {
  id: BoardKit;
  tray: TraySlot[];
  /** Drop a card or a stroke here to delete it. */
  bin: Rect;
  /** Size of a card pulled from the tray. */
  card: { w: number; h: number };
  /** Everything a view should show: tray, sheet and bin. */
  view: Rect;
}

const HLD_TYPES: ComponentType[] = [
  'client', 'lb', 'api_gateway', 'service', 'db', 'kv', 'cache', 'queue', 'cdn', 'object_store', 'search', 'worker', 'external',
];

const SLOT = { x: -12, w: 10, h: 2.6, pitch: 3.0, top: 0.5 } as const;

/** System design: 13 component cards. */
export const HLD_KIT: Kit = {
  id: 'hld',
  tray: HLD_TYPES.map((type, i) => ({
    type,
    name: COMPONENT_NAMES[type],
    x: SLOT.x,
    y: SLOT.top + i * SLOT.pitch,
    w: SLOT.w,
    h: SLOT.h,
  })),
  bin: { x: SHEET.w + 2, y: SHEET.h - 7, w: 7, h: 7 },
  card: { w: CARD.w, h: CARD.h },
  view: { x: -13, y: -1, w: SHEET.w + 24, h: SHEET.h + 2 },
};

export function traySlotAt(kit: Kit, x: number, y: number): TraySlot | null {
  return kit.tray.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) ?? null;
}
