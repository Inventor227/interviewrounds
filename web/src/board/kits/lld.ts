// Low-level design: class cards with member rows the Scribe fills ("ParkingLot has a list of
// levels"), relations between classes on the connector chip (uses, has a, is a, implements).
// A member row can be dragged to another class (member.move) or onto the bin (member.remove);
// a tap on it selects its class. A box drawn on the sheet becomes a class card.
import type { ClassItem } from '../../shared/types';
import { DRAG_THRESHOLD_CM } from '../input';
import { HLD_KIT, traySlots, type Kit, type KitHandler, type KitPress } from '../kits';
import { classLayout, inRect, itemRect, type MemberRow } from '../model';
import { font, memberText, roundRect } from '../render';

interface MemberPress {
  classId: string;
  row: MemberRow;
}

function classAt(board: { items: readonly unknown[] }, x: number, y: number, exclude?: string): ClassItem | null {
  const items = board.items as ClassItem[];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'class' && it.id !== exclude && inRect(itemRect(it), x, y)) return it;
  }
  return null;
}

const members: KitHandler = {
  hit(x, y, { board }) {
    const c = classAt(board, x, y);
    if (!c) return null;
    const row = classLayout(c).rows.find((r) => inRect(r.rect, x, y));
    return row ? ({ classId: c.id, row } satisfies MemberPress) : null;
  },
  up(press, { board, kit }) {
    const s = press.state as MemberPress;
    const moved = Math.hypot(press.x - press.start[0], press.y - press.start[1]) >= DRAG_THRESHOLD_CM;
    if (!moved) return { ops: [], focus: s.classId };
    if (inRect(kit.bin, press.x, press.y)) return { ops: [{ op: 'member.remove', args: { id: s.row.member.id } }] };
    const to = classAt(board, press.x, press.y, s.classId);
    if (to) return { ops: [{ op: 'member.move', args: { id: s.row.member.id, to_class_id: to.id } }], focus: to.id };
    return { ops: [] };
  },
  overlay(press: KitPress) {
    const s = press.state as MemberPress;
    if (Math.hypot(press.x - press.start[0], press.y - press.start[1]) < DRAG_THRESHOLD_CM) return null;
    const text = memberText(s.row.member, s.row.section === 'methods');
    const w = Math.min(16, 2 + text.length * 0.42);
    const r = { x: press.x - w / 2, y: press.y - 0.9, w, h: 1.8 };
    return {
      key: `${s.row.member.id}:${press.x.toFixed(1)}:${press.y.toFixed(1)}`,
      bounds: r,
      draw(ctx, _board, k) {
        ctx.save();
        ctx.shadowColor = 'rgba(28, 27, 26, 0.2)';
        ctx.shadowBlur = 0.6 * k;
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#1F4E79';
        ctx.lineWidth = Math.max(1.5, 0.08 * k);
        roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.4 * k);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.fillStyle = '#1C1B1A';
        ctx.font = font(0.65 * k, 500);
        ctx.textBaseline = 'middle';
        ctx.fillText(text, (r.x + 0.5) * k, (r.y + r.h / 2) * k, (r.w - 1) * k);
        ctx.restore();
      },
    };
  },
};

/** Object design: classes, interfaces, abstract classes, enums and notes. */
export const LLD_KIT: Kit = {
  ...HLD_KIT,
  id: 'lld',
  tray: traySlots(
    [
      { name: 'Class', make: { kind: 'class', class_kind: 'class' } },
      { name: 'Interface', make: { kind: 'class', class_kind: 'interface' } },
      { name: 'Abstract class', make: { kind: 'class', class_kind: 'abstract' } },
      { name: 'Enum', make: { kind: 'class', class_kind: 'enum' } },
      { name: 'Note', make: { kind: 'sticky' } },
    ],
    3.4,
    3.0,
  ),
  card: { w: 14, h: 7 },
  edgeChip: 'rel',
  defaultRel: 'uses',
  drawn: { rect: { kind: 'class', class_kind: 'class' }, circle: null },
  handler: members,
};
