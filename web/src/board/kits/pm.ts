// Product rounds: sticky notes in four lanes (users, pain points, ideas, metrics) and a ranked
// ladder of five rungs on the right. A sticky dropped in a lane is filed there; dropped on a
// rung it takes that rank, in one item.move (a rung can hold two while you sort them out).
// Text comes from voice (the Scribe); a box drawn on the sheet becomes a sticky.
import type { Board, BoardItem, Lane } from '../../shared/types';
import { HLD_KIT, traySlots, type Kit } from '../kits';
import { inRect, SHEET, type Rect } from '../model';
import { ACCENT, font, roundRect, withAlpha } from '../render';

export const LANES: { lane: Lane; name: string }[] = [
  { lane: 'user', name: 'Users' },
  { lane: 'pain', name: 'Pain points' },
  { lane: 'idea', name: 'Ideas' },
  { lane: 'metric', name: 'Metrics' },
];
/** Lanes take the left 48 cm (12 cm each, a 7 cm sticky fits with room to spare). */
const LANE_W = 12;
/** The ladder: the right 14 cm, five rungs under its header. */
export const LADDER: Rect = { x: LANE_W * LANES.length + 1, y: 0, w: SHEET.w - LANE_W * LANES.length - 1, h: SHEET.h };
export const RUNGS = 5;
const HEADER = 3;
const RUNG_H = (SHEET.h - HEADER - 0.5) / RUNGS;

export function laneAt(x: number): Lane | null {
  const i = Math.floor(x / LANE_W);
  return x >= 0 && i < LANES.length ? LANES[i]!.lane : null;
}

/** A ladder rung (1 = top). */
export function rungRect(rank: number): Rect {
  return { x: LADDER.x, y: HEADER + (rank - 1) * RUNG_H, w: LADDER.w, h: RUNG_H };
}

export function rungAt(x: number, y: number): number | null {
  for (let r = 1; r <= RUNGS; r++) if (inRect(rungRect(r), x, y)) return r;
  return null;
}

function place(item: BoardItem, x: number, y: number, _board: Board): { lane?: Lane | null; rank?: number | null } | null {
  if (item.kind !== 'sticky') return null;
  const rung = rungAt(x, y);
  if (rung) return { rank: rung };
  const lane = laneAt(x);
  if (!lane) return null;
  // Leaving the ladder clears the rank.
  return item.rank != null ? { lane, rank: null } : { lane };
}

function renderSheet(ctx: CanvasRenderingContext2D, _board: Board, k: number): void {
  ctx.save();
  LANES.forEach((l, i) => {
    const x = i * LANE_W;
    if (i % 2 === 1) {
      ctx.fillStyle = withAlpha(ACCENT, 0.035);
      ctx.fillRect(x * k, 0, LANE_W * k, SHEET.h * k);
    }
    if (i > 0) {
      ctx.strokeStyle = withAlpha(ACCENT, 0.18);
      ctx.lineWidth = Math.max(1, 0.05 * k);
      ctx.beginPath();
      ctx.moveTo(x * k, 0.6 * k);
      ctx.lineTo(x * k, (SHEET.h - 0.6) * k);
      ctx.stroke();
    }
    // Lane headers at 1.2 cm (research 06 §3.5).
    ctx.font = font(0.95 * k, 700);
    ctx.fillStyle = withAlpha(ACCENT, 0.75);
    ctx.textAlign = 'left';
    ctx.fillText(l.name, (x + 0.8) * k, 1.9 * k);
  });
  // The ladder.
  roundRect(ctx, (LADDER.x + 0.2) * k, 0.4 * k, (LADDER.w - 0.6) * k, (SHEET.h - 0.8) * k, 0.6 * k);
  ctx.fillStyle = withAlpha(ACCENT, 0.05);
  ctx.fill();
  ctx.font = font(0.95 * k, 700);
  ctx.fillStyle = withAlpha(ACCENT, 0.75);
  ctx.fillText('Ranked', (LADDER.x + 1) * k, 1.9 * k);
  for (let r = 1; r <= RUNGS; r++) {
    const rr = rungRect(r);
    ctx.strokeStyle = withAlpha(ACCENT, 0.2);
    ctx.lineWidth = Math.max(1, 0.05 * k);
    ctx.setLineDash([0.3 * k, 0.25 * k]);
    ctx.beginPath();
    ctx.moveTo((rr.x + 0.6) * k, (rr.y + rr.h) * k);
    ctx.lineTo((rr.x + rr.w - 0.8) * k, (rr.y + rr.h) * k);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = font(1.4 * k, 800);
    ctx.fillStyle = withAlpha(ACCENT, 0.16);
    ctx.textAlign = 'right';
    ctx.fillText(String(r), (rr.x + rr.w - 0.9) * k, (rr.y + rr.h - 0.6) * k);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/** Product rounds: a sticky pad and metric cards in the tray, lanes and a ladder on the sheet. */
export const PM_KIT: Kit = {
  ...HLD_KIT,
  id: 'pm',
  tray: traySlots([
    { name: 'Sticky note', make: { kind: 'sticky' } },
    { name: 'North star', make: { kind: 'metric', role: 'north_star' } },
    { name: 'Input metric', make: { kind: 'metric', role: 'input' } },
    { name: 'Guardrail', make: { kind: 'metric', role: 'guardrail' } },
  ]),
  card: { w: 7, h: 7 },
  drawn: { rect: { kind: 'sticky' }, circle: null },
  place,
  renderSheet,
};
