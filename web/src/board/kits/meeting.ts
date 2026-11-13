// Meeting rehearsal: the agenda card (pinch an item to tick it, again to untick), the key
// number cards from the setup (drag one onto the screen pad to show it while citing it), what
// is on screen, and the parking lot of questions the Scribe parked. Everything here is board
// data (board.meeting); no tray.
import type { Board } from '../../shared/types';
import { DRAG_THRESHOLD_CM } from '../input';
import { HLD_KIT, type Kit, type KitHandler, type KitPress } from '../kits';
import { inRect, SHEET, type Rect } from '../model';
import { ACCENT, ellipsize, font, roundRect, withAlpha } from '../render';

export const AGENDA: Rect = { x: 2, y: 2, w: 28, h: 24 };
const AGENDA_HEADER = 3;
/** Hand sized rows (research 06: targets at least 2.2 cm). */
const AGENDA_ROW = 2.4;
export const NUMBERS: Rect = { x: 34, y: 2, w: 28, h: 18 };
const NUM_W = 8.8;
const NUM_H = 5;
const NUM_GAP = 0.8;
export const SCREEN: Rect = { x: 34, y: 23, w: 28, h: 15 };
export const PARKING: Rect = { x: 2, y: 28, w: 28, h: 10 };

export function agendaRowRect(i: number): Rect {
  return { x: AGENDA.x + 0.4, y: AGENDA.y + AGENDA_HEADER + i * AGENDA_ROW, w: AGENDA.w - 0.8, h: AGENDA_ROW };
}

export function numberCardRect(i: number): Rect {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return { x: NUMBERS.x + col * (NUM_W + NUM_GAP), y: NUMBERS.y + 2.6 + row * (NUM_H + NUM_GAP), w: NUM_W, h: NUM_H };
}

type MeetingPress = { kind: 'agenda'; id: string } | { kind: 'number'; id: string };

const moved = (p: KitPress) => Math.hypot(p.x - p.start[0], p.y - p.start[1]) >= DRAG_THRESHOLD_CM;

const handler: KitHandler = {
  hit(x, y, { board }) {
    const m = board.meeting;
    if (!m) return null;
    const a = m.agenda.findIndex((_, i) => inRect(agendaRowRect(i), x, y));
    if (a >= 0) return { kind: 'agenda', id: m.agenda[a]!.id } satisfies MeetingPress;
    const n = (m.numbers ?? []).findIndex((_, i) => inRect(numberCardRect(i), x, y));
    if (n >= 0) return { kind: 'number', id: m.numbers![n]!.id } satisfies MeetingPress;
    return null;
  },
  up(press, { board, now_s }) {
    const s = press.state as MeetingPress;
    const m = board.meeting;
    if (!m) return { ops: [] };
    if (s.kind === 'agenda') {
      if (moved(press)) return { ops: [] };
      const item = m.agenda.find((a) => a.id === s.id);
      if (!item) return { ops: [] };
      const done = !item.done;
      return { ops: [{ op: 'agenda.check', args: { id: s.id, done, t: now_s() } }] };
    }
    if (moved(press) && inRect(SCREEN, press.x, press.y)) {
      return { ops: [{ op: 'present.show', args: { kind: 'number', ref: s.id, t: now_s() } }] };
    }
    return { ops: [] };
  },
  overlay(press, board) {
    const s = press.state as MeetingPress;
    if (s.kind !== 'number' || !moved(press)) return null;
    const n = board.meeting?.numbers?.find((x) => x.id === s.id);
    if (!n) return null;
    const r = { x: press.x - NUM_W / 2, y: press.y - NUM_H / 2, w: NUM_W, h: NUM_H };
    const hot = inRect(SCREEN, press.x, press.y);
    return {
      key: `${s.id}:${press.x.toFixed(1)}:${press.y.toFixed(1)}:${hot}`,
      bounds: hot ? { x: Math.min(r.x, SCREEN.x), y: Math.min(r.y, SCREEN.y), w: Math.max(r.x + r.w, SCREEN.x + SCREEN.w) - Math.min(r.x, SCREEN.x), h: Math.max(r.y + r.h, SCREEN.y + SCREEN.h) - Math.min(r.y, SCREEN.y) } : r,
      draw(ctx, _b, k) {
        if (hot) {
          roundRect(ctx, SCREEN.x * k, SCREEN.y * k, SCREEN.w * k, SCREEN.h * k, 0.8 * k);
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = Math.max(2, 0.15 * k);
          ctx.stroke();
        }
        numberCard(ctx, r, n.label, n.value, k, true);
      },
    };
  },
};

function numberCard(ctx: CanvasRenderingContext2D, r: Rect, label: string, value: string, k: number, lifted = false): void {
  ctx.save();
  if (lifted) {
    ctx.shadowColor = 'rgba(28, 27, 26, 0.22)';
    ctx.shadowBlur = 0.8 * k;
    ctx.shadowOffsetY = 0.3 * k;
  }
  roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.5 * k);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.strokeStyle = '#C9CFD8';
  ctx.lineWidth = Math.max(1, 0.05 * k);
  ctx.stroke();
  ctx.fillStyle = '#6B6760';
  ctx.font = font(0.55 * k, 600);
  ctx.textAlign = 'left';
  ctx.fillText(ellipsize(ctx, label.toUpperCase(), (r.w - 1) * k), (r.x + 0.5) * k, (r.y + 1.3) * k);
  ctx.fillStyle = '#1C1B1A';
  ctx.font = font(1.25 * k, 750);
  ctx.fillText(ellipsize(ctx, value, (r.w - 1) * k), (r.x + 0.5) * k, (r.y + 3.6) * k);
  ctx.restore();
}

function panel(ctx: CanvasRenderingContext2D, r: Rect, title: string, k: number): void {
  roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.7 * k);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = '#D5D9E0';
  ctx.lineWidth = Math.max(1, 0.05 * k);
  ctx.stroke();
  ctx.fillStyle = withAlpha(ACCENT, 0.85);
  ctx.font = font(0.8 * k, 700);
  ctx.textAlign = 'left';
  ctx.fillText(title, (r.x + 0.8) * k, (r.y + 1.7) * k);
}

function renderSheet(ctx: CanvasRenderingContext2D, board: Board, k: number): void {
  const m = board.meeting;
  if (!m) return;
  ctx.save();
  // Agenda.
  panel(ctx, AGENDA, 'Agenda', k);
  m.agenda.forEach((a, i) => {
    const r = agendaRowRect(i);
    if (r.y + r.h > AGENDA.y + AGENDA.h) return;
    const box = { x: r.x + 0.4, y: r.y + 0.5, w: 1.4, h: 1.4 };
    roundRect(ctx, box.x * k, box.y * k, box.w * k, box.h * k, 0.25 * k);
    ctx.fillStyle = a.done ? ACCENT : '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = a.done ? ACCENT : '#98A2AE';
    ctx.lineWidth = Math.max(1.5, 0.08 * k);
    ctx.stroke();
    if (a.done) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = Math.max(2, 0.16 * k);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo((box.x + 0.32) * k, (box.y + 0.72) * k);
      ctx.lineTo((box.x + 0.6) * k, (box.y + 1.02) * k);
      ctx.lineTo((box.x + 1.1) * k, (box.y + 0.4) * k);
      ctx.stroke();
    }
    ctx.fillStyle = a.done ? '#6B6760' : '#1C1B1A';
    ctx.font = font(0.75 * k, a.done ? 500 : 600);
    ctx.fillText(ellipsize(ctx, a.text, (r.w - 3) * k), (r.x + 2.4) * k, (r.y + 1.5) * k);
    if (a.done) {
      const w = Math.min(ctx.measureText(a.text).width, (r.w - 3) * k);
      ctx.strokeStyle = '#6B6760';
      ctx.lineWidth = Math.max(1, 0.05 * k);
      ctx.beginPath();
      ctx.moveTo((r.x + 2.4) * k, (r.y + 1.25) * k);
      ctx.lineTo((r.x + 2.4) * k + w, (r.y + 1.25) * k);
      ctx.stroke();
    }
  });
  // Key numbers.
  ctx.fillStyle = withAlpha(ACCENT, 0.85);
  ctx.font = font(0.8 * k, 700);
  ctx.fillText('Key numbers', (NUMBERS.x + 0.2) * k, (NUMBERS.y + 1.7) * k);
  (m.numbers ?? []).forEach((n, i) => {
    const r = numberCardRect(i);
    if (r.y + r.h <= NUMBERS.y + NUMBERS.h) numberCard(ctx, r, n.label, n.value, k);
  });
  // The screen pad: what is shown now.
  roundRect(ctx, SCREEN.x * k, SCREEN.y * k, SCREEN.w * k, SCREEN.h * k, 0.8 * k);
  ctx.fillStyle = '#23272E';
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = font(0.6 * k, 700);
  ctx.fillText('ON SCREEN', (SCREEN.x + 0.8) * k, (SCREEN.y + 1.4) * k);
  const last = m.shown[m.shown.length - 1];
  ctx.textAlign = 'center';
  if (!last) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = font(0.75 * k, 500);
    ctx.fillText('Drop a number here to show it', (SCREEN.x + SCREEN.w / 2) * k, (SCREEN.y + SCREEN.h / 2 + 0.3) * k);
  } else if (last.kind === 'number') {
    const n = m.numbers?.find((x) => x.id === last.ref);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = font(0.8 * k, 600);
    ctx.fillText(n?.label ?? String(last.ref), (SCREEN.x + SCREEN.w / 2) * k, (SCREEN.y + 5.4) * k);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = font(2.6 * k, 800);
    ctx.fillText(n?.value ?? '', (SCREEN.x + SCREEN.w / 2) * k, (SCREEN.y + 9.6) * k);
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.font = font(1.6 * k, 700);
    ctx.fillText(`Slide ${last.ref}`, (SCREEN.x + SCREEN.w / 2) * k, (SCREEN.y + SCREEN.h / 2 + 0.5) * k);
  }
  ctx.textAlign = 'left';
  // Parking lot.
  panel(ctx, PARKING, 'Parking lot', k);
  ctx.font = font(0.65 * k, 500);
  ctx.fillStyle = m.parked.length ? '#1C1B1A' : '#6B6760';
  const lines = m.parked.length ? m.parked.slice(-5) : ['Questions to come back to land here.'];
  lines.forEach((p, i) => {
    ctx.fillText(ellipsize(ctx, m.parked.length ? `• ${p}` : p, (PARKING.w - 1.6) * k), (PARKING.x + 0.8) * k, (PARKING.y + 3.2 + i * 1.3) * k);
  });
  ctx.restore();
}

/** Meeting rehearsal: agenda, key numbers, the screen and the parking lot. */
export const MEETING_KIT: Kit = {
  ...HLD_KIT,
  id: 'meeting',
  tray: [],
  bin: { x: SHEET.w + 2, y: SHEET.h - 7, w: 7, h: 7 },
  view: { x: -1, y: -1, w: SHEET.w + 12, h: SHEET.h + 2 },
  drawn: { rect: null, circle: null },
  handler,
  renderSheet,
};
