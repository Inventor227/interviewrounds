// Coding (DSA): "you talk, the Scribe types, your hands edit" (research 06 §3.3, §6).
// - The code panel stands on the dominant side like a laptop screen and shows board.code.lines
//   (the Scribe writes them with code.insert / code.edit). Pinch a line and drag it up or down
//   to reorder it (one code.move); move it sideways to indent (every 2.5 cm is a level, the
//   result clamped to 0..6; one code.indent); drop it on the bin to delete it.
// - The trace marker in the gutter walks the lines while you explain a test: each line it
//   reaches is logged (code.trace, with the round time).
// - On the sheet: the Approach card (the Scribe's bullets) and the Time and Space slots;
//   complexity chips from the tray drop on a slot (code.complexity).
// - The short round's Parsons puzzle uses the same panel; its first and last lines are locked.
import type { Board, CodeLine } from '../../shared/types';
import { DRAG_THRESHOLD_CM } from '../input';
import { traySlots, type Kit, type KitHandler, type KitOp, type KitPress } from '../kits';
import { inRect, SHEET, type Rect } from '../model';
import { ACCENT, ellipsize, font, roundRect, withAlpha } from '../render';

export const CHIPS = ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n²)', 'O(2ⁿ)'];
/** Sideways travel for one indent level. */
export const INDENT_CM = 2.5;
export const APPROACH: Rect = { x: 2, y: 2, w: 42, h: 19 };
export const SLOTS: { time: Rect; space: Rect } = {
  time: { x: 2, y: 24, w: 20, h: 10 },
  space: { x: 24, y: 24, w: 20, h: 10 },
};
/** The code panel (40 x 30 cm), right of the sheet for a right-handed user. */
const PANEL: Rect = { x: SHEET.w + 4, y: 0, w: 40, h: 30 };
const HEADER = 2.6;
const GUTTER = 2.6;
/** Line pitch on the panel (research 06: 1.4 cm; a little more for pinching). */
export const LINE_H = 1.5;
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";

export function codeLineRect(panel: Rect, i: number): Rect {
  return { x: panel.x + GUTTER, y: panel.y + HEADER + i * LINE_H, w: panel.w - GUTTER - 0.4, h: LINE_H };
}

/** Lines that fit on the panel. */
export function visibleLines(panel: Rect): number {
  return Math.floor((panel.h - HEADER - 0.4) / LINE_H);
}

function rowAt(panel: Rect, y: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.floor((y - panel.y - HEADER) / LINE_H)));
}

function traceRow(board: Board): number {
  const code = board.code;
  const last = code?.trace[code.trace.length - 1];
  const i = last ? code!.lines.findIndex((l) => l.id === last.line) : -1;
  return Math.max(0, i);
}

/** The trace marker: a triangle in the gutter at the line last traced (the first line before any). */
export function traceMarkerRect(panel: Rect, board: Board): Rect {
  const r = codeLineRect(panel, traceRow(board));
  return { x: panel.x + 0.2, y: r.y, w: GUTTER - 0.4, h: LINE_H };
}

type CodePress =
  | { kind: 'line'; id: string; index: number; indent: number; locked: boolean }
  | { kind: 'trace'; row: number };

const moved = (p: KitPress) => Math.hypot(p.x - p.start[0], p.y - p.start[1]) >= DRAG_THRESHOLD_CM;

function handler(locked: ReadonlySet<string>): KitHandler {
  return {
    hit(x, y, { board, kit }) {
      const panel = kit.panel;
      const lines = board.code?.lines;
      if (!panel || !lines || !inRect(panel, x, y)) return null;
      const n = Math.min(lines.length, visibleLines(panel));
      if (n && inRect(traceMarkerRect(panel, board), x, y)) return { kind: 'trace', row: traceRow(board) } satisfies CodePress;
      for (let i = 0; i < n; i++) {
        if (inRect(codeLineRect(panel, i), x, y)) {
          const l = lines[i]!;
          return { kind: 'line', id: l.id, index: i, indent: l.indent, locked: locked.has(l.id) } satisfies CodePress;
        }
      }
      return null;
    },
    move(press, { board, kit, now_s }) {
      const s = press.state as CodePress;
      const lines = board.code?.lines;
      if (s.kind !== 'trace' || !lines || !kit.panel) return [];
      const row = rowAt(kit.panel, press.y, Math.min(lines.length, visibleLines(kit.panel)));
      if (row === s.row) return [];
      s.row = row;
      return [{ op: 'code.trace', args: { line: lines[row]!.id, t: now_s() } }];
    },
    up(press, { board, kit }) {
      const s = press.state as CodePress;
      const lines = board.code?.lines;
      if (s.kind !== 'line' || !lines || !kit.panel || s.locked || !moved(press)) return { ops: [] };
      if (inRect(kit.bin, press.x, press.y) || press.x < kit.panel.x - 8 || press.x > kit.panel.x + kit.panel.w + 8) {
        return { ops: [{ op: 'code.delete', args: { id: s.id } }] };
      }
      const ops: KitOp[] = [];
      // Where it goes: the row under the pointer, kept inside any locked first and last lines.
      let target = rowAt(kit.panel, press.y, Math.min(lines.length, visibleLines(kit.panel)));
      if (lines[0] && locked.has(lines[0].id)) target = Math.max(1, target);
      const lastLine = lines[lines.length - 1];
      if (lastLine && locked.has(lastLine.id)) target = Math.min(lines.length - 2, target);
      if (target !== s.index) {
        const rest = lines.filter((l) => l.id !== s.id);
        ops.push({ op: 'code.move', args: { id: s.id, after: target === 0 ? null : rest[target - 1]!.id } });
      }
      // Sideways: whole levels only, the result kept in 0..6.
      const levels = Math.trunc((press.x - press.start[0]) / INDENT_CM);
      const delta = Math.max(0, Math.min(6, s.indent + levels)) - s.indent;
      if (delta !== 0) ops.push({ op: 'code.indent', args: { id: s.id, delta } });
      return { ops };
    },
    overlay(press, board) {
      const s = press.state as CodePress;
      const line = s.kind === 'line' ? board.code?.lines.find((l) => l.id === s.id) : null;
      if (s.kind === 'line' && (!line || !moved(press) || s.locked)) return null;
      const panelX = press.start[0];
      if (s.kind === 'trace') {
        const y = press.y - LINE_H / 2;
        const r = { x: panelX - 1, y, w: 2, h: LINE_H };
        return {
          key: `trace:${s.row}:${press.y.toFixed(1)}`,
          bounds: r,
          surface: 'panel',
          draw: (ctx, _b, k) => marker(ctx, r.x + 0.2, r.y, k, ACCENT),
        };
      }
      const levels = Math.trunc((press.x - press.start[0]) / INDENT_CM);
      const indent = Math.max(0, Math.min(6, line!.indent + levels));
      const r = { x: press.x - 12, y: press.y - LINE_H / 2, w: 24, h: LINE_H };
      return {
        key: `line:${s.id}:${press.x.toFixed(1)}:${press.y.toFixed(1)}`,
        bounds: r,
        surface: 'panel',
        draw(ctx, _b, k) {
          ctx.save();
          ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
          ctx.shadowBlur = 0.6 * k;
          roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.3 * k);
          ctx.fillStyle = '#2B3A55';
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#6EA8FE';
          ctx.lineWidth = Math.max(1.5, 0.07 * k);
          ctx.stroke();
          ctx.fillStyle = '#F4F6FA';
          ctx.font = `500 ${Math.max(1, 0.62 * k)}px ${MONO}`;
          ctx.textBaseline = 'middle';
          ctx.fillText(`${'    '.repeat(indent)}${line!.text}`, (r.x + 0.4) * k, (r.y + LINE_H / 2) * k, (r.w - 0.8) * k);
          ctx.restore();
        },
      };
    },
  };
}

function marker(ctx: CanvasRenderingContext2D, x: number, y: number, k: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo((x + 0.3) * k, (y + 0.3) * k);
  ctx.lineTo((x + 1.5) * k, (y + LINE_H / 2) * k);
  ctx.lineTo((x + 0.3) * k, (y + LINE_H - 0.3) * k);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function slot(ctx: CanvasRenderingContext2D, r: Rect, title: string, value: string | null, k: number): void {
  roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.7 * k);
  ctx.fillStyle = value ? withAlpha('#5B4BA0', 0.08) : '#FFFFFF';
  ctx.fill();
  ctx.setLineDash(value ? [] : [0.4 * k, 0.3 * k]);
  ctx.strokeStyle = value ? '#5B4BA0' : '#B9B2A6';
  ctx.lineWidth = Math.max(1, 0.07 * k);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#6B6760';
  ctx.font = font(0.7 * k, 700);
  ctx.textAlign = 'left';
  ctx.fillText(title.toUpperCase(), (r.x + 0.8) * k, (r.y + 1.6) * k);
  ctx.textAlign = 'center';
  ctx.fillStyle = value ? '#5B4BA0' : '#9A958C';
  ctx.font = value ? font(1.8 * k, 800) : font(0.65 * k, 500, 'italic');
  ctx.fillText(value ?? 'Drop a chip here', (r.x + r.w / 2) * k, (r.y + r.h / 2 + (value ? 1.2 : 0.8)) * k);
  ctx.textAlign = 'left';
}

function renderSheet(ctx: CanvasRenderingContext2D, board: Board, k: number): void {
  const code = board.code;
  if (!code) return;
  ctx.save();
  // Approach card.
  roundRect(ctx, APPROACH.x * k, APPROACH.y * k, APPROACH.w * k, APPROACH.h * k, 0.7 * k);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = '#D5D9E0';
  ctx.lineWidth = Math.max(1, 0.05 * k);
  ctx.stroke();
  ctx.fillStyle = withAlpha(ACCENT, 0.85);
  ctx.font = font(0.8 * k, 700);
  ctx.textAlign = 'left';
  ctx.fillText('Approach', (APPROACH.x + 0.8) * k, (APPROACH.y + 1.7) * k);
  ctx.font = font(0.8 * k, 500, code.approach.length ? '' : 'italic');
  ctx.fillStyle = code.approach.length ? '#1C1B1A' : '#9A958C';
  const items = code.approach.length ? code.approach.map((a) => `•  ${a}`) : ['Say how you will solve it: the steps appear here.'];
  items.slice(0, 6).forEach((a, i) => ctx.fillText(ellipsize(ctx, a, (APPROACH.w - 1.6) * k), (APPROACH.x + 0.8) * k, (APPROACH.y + 3.8 + i * 2.2) * k));
  slot(ctx, SLOTS.time, 'Time', code.complexity.time, k);
  slot(ctx, SLOTS.space, 'Space', code.complexity.space, k);
  ctx.restore();
}

/** The code panel at kit.panel: a dark screen with the lines, the gutter and the trace marker. */
export function renderCodePanel(ctx: CanvasRenderingContext2D, board: Board, k: number, panel: Rect, locked: ReadonlySet<string> = new Set()): void {
  const code = board.code;
  ctx.save();
  roundRect(ctx, panel.x * k, panel.y * k, panel.w * k, panel.h * k, 0.8 * k);
  ctx.fillStyle = '#1E2229';
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = font(0.65 * k, 700);
  ctx.textAlign = 'left';
  ctx.fillText(`CODE${code ? `  ·  ${code.language}` : ''}`.toUpperCase(), (panel.x + 0.8) * k, (panel.y + 1.6) * k);
  if (!code) {
    ctx.restore();
    return;
  }
  const n = Math.min(code.lines.length, visibleLines(panel));
  if (!n) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = font(0.7 * k, 500, 'italic');
    ctx.fillText('Talk through your code: the lines appear here.', (panel.x + GUTTER) * k, (panel.y + HEADER + 1) * k);
  }
  const traced = new Set(code.trace.map((t) => t.line));
  for (let i = 0; i < n; i++) {
    const l: CodeLine = code.lines[i]!;
    const r = codeLineRect(panel, i);
    if (i % 2 === 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
      ctx.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
    }
    ctx.fillStyle = traced.has(l.id) ? 'rgba(110, 168, 254, 0.9)' : 'rgba(255, 255, 255, 0.35)';
    ctx.font = `500 ${Math.max(1, 0.5 * k)}px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(String(i + 1), (panel.x + GUTTER - 0.4) * k, (r.y + 1.0) * k);
    ctx.textAlign = 'left';
    // Indent guides.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = Math.max(1, 0.03 * k);
    for (let d = 1; d <= l.indent; d++) {
      const gx = r.x + 0.4 + (d - 0.5) * 1.5;
      ctx.beginPath();
      ctx.moveTo(gx * k, r.y * k);
      ctx.lineTo(gx * k, (r.y + r.h) * k);
      ctx.stroke();
    }
    ctx.fillStyle = locked.has(l.id) ? 'rgba(244, 246, 250, 0.6)' : '#F4F6FA';
    ctx.font = `500 ${Math.max(1, 0.62 * k)}px ${MONO}`;
    ctx.fillText(ellipsize(ctx, l.text, (r.w - 0.8 - l.indent * 1.5) * k), (r.x + 0.4 + l.indent * 1.5) * k, (r.y + 1.0) * k);
  }
  if (code.lines.length > n) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.font = font(0.55 * k, 500);
    ctx.fillText(`${code.lines.length - n} more`, (panel.x + GUTTER) * k, (panel.y + panel.h - 0.3) * k);
  }
  if (n) {
    const m = traceMarkerRect(panel, board);
    marker(ctx, m.x, m.y, k, code.trace.length ? '#6EA8FE' : 'rgba(110, 168, 254, 0.45)');
  }
  ctx.restore();
}

/**
 * The coding kit. `locked` line ids (the Parsons puzzle's first and last lines) cannot be
 * moved, and nothing can be moved above the first or below the last of them.
 */
export function createCodingKit(opts: { locked?: readonly string[] } = {}): Kit {
  const locked = new Set(opts.locked ?? []);
  const kit: Kit = {
    id: 'coding',
    tray: traySlots(CHIPS.map((value) => ({ name: value, make: { kind: 'chip', value } }))),
    bin: { x: -12, y: 32, w: 10, h: 7 },
    card: { w: 6, h: 2.4 },
    panel: PANEL,
    view: { x: -13, y: -1, w: PANEL.x + PANEL.w + 1 + 13, h: SHEET.h + 2 },
    drawn: { rect: null, circle: null },
    trayDrop(slotDef, x, y, { board }) {
      if (slotDef.make.kind !== 'chip' || !board.code) return null;
      const value = slotDef.make.value;
      if (inRect(SLOTS.time, x, y)) return { op: 'code.complexity', args: { slot: 'time', value } };
      if (inRect(SLOTS.space, x, y)) return { op: 'code.complexity', args: { slot: 'space', value } };
      return null;
    },
    handler: handler(locked),
    renderSheet,
    renderPanel(ctx, board, k) {
      if (this.panel) renderCodePanel(ctx, board, k, this.panel, locked);
    },
  };
  return kit;
}
