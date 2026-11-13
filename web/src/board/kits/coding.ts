// Coding (DSA): "you talk, the Scribe types, your hands edit" (research 06 §3.3, §6).
// - The code panel stands on the dominant side like a laptop screen and shows board.code.lines
//   (the Scribe writes them with code.insert / code.edit). Pinch a line and drag it up or down
//   to reorder it (one code.move), or sideways to indent it (every 2.5 cm is a level, the
//   result clamped to 0..6; one code.indent). The first centimetre picks the axis and the
//   gesture keeps it. Drop it on the bin, or well off the panel toward the sheet, to delete it.
//   Longer code scrolls: pinch the "n more" strip (or the header) and pull, or tap it to page.
//   The panel follows the Scribe: a new or edited line out of view scrolls it into view, unless
//   the user scrolled by hand in the last 5 s (then the strip says "New line below").
// - The trace marker in the gutter walks the lines while you explain a test: each line it
//   stops on is logged (code.trace, with the round time), once the hand is clearly inside it.
// - On the sheet: the Approach card (the Scribe's bullets) and the Time and Space slots;
//   complexity chips from the tray drop on a slot (code.complexity).
// - The short round's Parsons puzzle uses the same panel; its first and last lines are locked.
import type { Board, CodeLine } from '../../shared/types';
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
/** The code panel (44 x 34 cm), right of the sheet for a right-handed user. */
const PANEL: Rect = { x: SHEET.w + 4, y: 0, w: 44, h: 34 };
const HEADER = 2.6;
/** The strip under the lines: "n more", pinch it to scroll (hand sized). */
const FOOTER = 2.4;
const GUTTER = 2.8;
/** Line pitch on the panel (research 06: 1.4 cm; more, so lines are big enough to pinch and read). */
export const LINE_H = 1.8;
/**
 * Code type size (cm). The panel stands about 0.75 m from the eyes, so 0.9 cm at 0.6 m (the
 * minimum comfortable size) needs about 1.12 cm here (xr.test checks it against the geometry).
 */
export const CODE_FONT_CM = 1.15;
/** Indent drawn per level (two monospace characters at CODE_FONT_CM). */
const INDENT_DRAW = 1.4;
/** A line gesture picks its axis (reorder up and down, or indent sideways) after this much travel. */
export const AXIS_LOCK_CM = 1;
/** The trace marker steps only when the hand is this far into the next line... */
export const TRACE_HYSTERESIS_CM = 0.4 * LINE_H;
/** ...and has stayed there this long (or lets go there). */
export const TRACE_DWELL_MS = 150;
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace";

export function codeLineRect(panel: Rect, i: number): Rect {
  return { x: panel.x + GUTTER, y: panel.y + HEADER + i * LINE_H, w: panel.w - GUTTER - 0.4, h: LINE_H };
}

/** Lines that fit on the panel at once. */
export function visibleLines(panel: Rect): number {
  return Math.floor((panel.h - HEADER - FOOTER) / LINE_H);
}

const headerRect = (panel: Rect): Rect => ({ x: panel.x, y: panel.y, w: panel.w, h: HEADER });
const footerRect = (panel: Rect): Rect => ({ x: panel.x, y: panel.y + HEADER + visibleLines(panel) * LINE_H, w: panel.w, h: panel.h - HEADER - visibleLines(panel) * LINE_H });

/** After a manual scroll, the panel waits this long before following new lines again (ms). */
export const FOLLOW_PAUSE_MS = 5000;

/**
 * What this user's panel shows: local view state, never board data. `top` is the first line
 * shown, anchored to that line's id so edits above the view do not shift it. New or edited
 * lines outside the view scroll it to them, unless the user scrolled by hand in the last
 * FOLLOW_PAUSE_MS or is holding a line: then `cue` names the line and the panel says so.
 */
interface PanelView {
  top: number;
  anchor: string | null;
  /** When the user last scrolled by hand (view clock, ms). */
  manualAt: number;
  /** Presses on the panel now (no following while a line is held). */
  live: Set<unknown>;
  code: Board['code'] | null;
  seen: Map<string, string> | null;
  cue: string | null;
  now(): number;
}

/** The first line shown, kept in range, following new lines (see PanelView). */
function topLine(view: PanelView, board: Board, panel: Rect): number {
  const code = board.code ?? null;
  const lines = code?.lines ?? [];
  const rows = visibleLines(panel);
  if (code !== view.code) {
    const seen = view.seen;
    const kept = seen ? lines.filter((l) => seen.has(l.id)).length : 0;
    const idsChanged = !seen || kept !== lines.length || kept !== seen.size;
    if (seen && kept === 0 && lines.length > 0) {
      // All new code (a Parsons deal, a rewrite with fresh ids): open it at the top.
      view.top = 0;
      view.cue = null;
    } else {
      // Lines added or removed above the view: keep showing the same first line. A pure
      // reorder (the user moved a line) keeps the rows where they are, so what was just
      // dropped stays where it was dropped.
      if (idsChanged && view.anchor) {
        const i = lines.findIndex((l) => l.id === view.anchor);
        if (i >= 0) view.top = i;
      }
      // The newest change: the last line that is new or reads differently.
      let changed = -1;
      if (seen) for (let i = 0; i < lines.length; i++) if (seen.get(lines[i]!.id) !== `${lines[i]!.indent}|${lines[i]!.text}`) changed = i;
      if (changed >= 0 && (changed < view.top || changed >= view.top + rows)) {
        const held = view.live.size > 0 || view.now() - view.manualAt < FOLLOW_PAUSE_MS;
        if (held) view.cue = lines[changed]!.id;
        else view.top = changed < view.top ? changed : changed - rows + 1;
      }
    }
    view.seen = code ? new Map(lines.map((l) => [l.id, `${l.indent}|${l.text}`])) : null;
    view.code = code;
  }
  view.top = Math.max(0, Math.min(view.top, lines.length - rows));
  view.anchor = lines[view.top]?.id ?? null;
  if (view.cue) {
    const i = lines.findIndex((l) => l.id === view.cue);
    if (i < 0 || (i >= view.top && i < view.top + rows)) view.cue = null;
  }
  return view.top;
}

/** Shows the cued line (a tap on the cue), or pages by `page`. */
function pageOrCue(view: PanelView, board: Board, panel: Rect, top0: number, page: 1 | -1): void {
  const rows = visibleLines(panel);
  const i = view.cue ? (board.code?.lines.findIndex((l) => l.id === view.cue) ?? -1) : -1;
  if (i >= 0 && Math.sign(i - top0) === page) view.top = page > 0 ? i - rows + 1 : i;
  else view.top = top0 + page * Math.max(1, rows - 2);
  view.cue = null;
  view.manualAt = view.now();
  topLine(view, board, panel);
}

/** Where the cued line is: below or above the view, or null. */
function cueSide(view: PanelView, board: Board): 'below' | 'above' | null {
  const i = view.cue ? (board.code?.lines.findIndex((l) => l.id === view.cue) ?? -1) : -1;
  return i < 0 ? null : i < view.top ? 'above' : 'below';
}

/** The screen row (0 based) at y, clamped to the rows shown. */
function rowAt(panel: Rect, y: number, rows: number): number {
  return Math.max(0, Math.min(rows - 1, Math.floor((y - panel.y - HEADER) / LINE_H)));
}

function traceIndex(board: Board): number {
  const code = board.code;
  const last = code?.trace[code.trace.length - 1];
  const i = last ? code!.lines.findIndex((l) => l.id === last.line) : -1;
  return Math.max(0, i);
}

/**
 * The trace marker: a triangle in the gutter at the line last traced (the first line before
 * any), kept on screen when that line is scrolled away. `top` is the first line shown.
 */
export function traceMarkerRect(panel: Rect, board: Board, top = 0): Rect {
  const row = Math.max(0, Math.min(visibleLines(panel) - 1, traceIndex(board) - top));
  const r = codeLineRect(panel, row);
  return { x: panel.x + 0.2, y: r.y, w: GUTTER - 0.4, h: LINE_H };
}

type CodePress =
  | { kind: 'line'; id: string; index: number; indent: number; locked: boolean; axis: 'v' | 'h' | null }
  | { kind: 'trace'; row: number; cand: number | null; since: number; steps: number; moved: boolean }
  | { kind: 'scroll'; top0: number; page: 1 | -1; moved: boolean };

/** The panel is right of the sheet (right-handed) or left of it. */
const panelOnRight = (panel: Rect) => panel.x >= SHEET.w / 2;

/** Let go here and the held line is deleted: the bin, or well off the panel toward the sheet. */
function deletesAt(kit: Kit, x: number, y: number): boolean {
  const panel = kit.panel!;
  if (inRect(kit.bin, x, y)) return true;
  return panelOnRight(panel) ? x < panel.x - 8 : x > panel.x + panel.w + 8;
}

/** The axis a line gesture keeps, picked once it has travelled AXIS_LOCK_CM. */
function lockAxis(press: KitPress, s: Extract<CodePress, { kind: 'line' }>): void {
  if (s.axis) return;
  const dx = press.x - press.start[0];
  const dy = press.y - press.start[1];
  if (Math.hypot(dx, dy) >= AXIS_LOCK_CM) s.axis = Math.abs(dy) >= Math.abs(dx) ? 'v' : 'h';
}

const indentLevels = (press: KitPress) => Math.trunc((press.x - press.start[0]) / INDENT_CM);

function handler(locked: ReadonlySet<string>, scroll: PanelView): KitHandler {
  /** The trace marker's next step, if the hand is clearly in another line and stayed (or let go). */
  const traceStep = (press: KitPress, s: Extract<CodePress, { kind: 'trace' }>, board: Board, panel: Rect, release: boolean, now_s: () => number): KitOp[] => {
    const lines = board.code?.lines;
    if (!lines?.length) return [];
    const top = topLine(scroll, board, panel);
    const rows = Math.min(lines.length - top, visibleLines(panel));
    if (Math.abs(press.y - press.start[1]) >= TRACE_HYSTERESIS_CM) s.moved = true;
    const cur = codeLineRect(panel, s.row - top);
    const stays = press.y >= cur.y - TRACE_HYSTERESIS_CM && press.y <= cur.y + cur.h + TRACE_HYSTERESIS_CM;
    const cand = stays ? null : top + rowAt(panel, press.y, rows);
    if (cand !== s.cand) {
      s.cand = cand;
      s.since = press.t_ms;
    }
    let row: number | null = null;
    // Steps need the hand to have moved off where it pinched (the marker may stand in for a line scrolled away).
    // When the marker stands in for a line scrolled away, the row it was pinched on is not a step.
    const offScreen = s.row < top || s.row >= top + rows;
    const fromStandIn = offScreen && s.steps === 0 && s.cand === top + rowAt(panel, press.start[1], rows);
    if (s.cand != null && s.moved && !fromStandIn && (release || press.t_ms - s.since >= TRACE_DWELL_MS)) row = s.cand;
    // A pinch on the marker without moving it logs the line it is on (so the first line counts),
    // when that line is on screen.
    else if (release && !s.moved && s.steps === 0 && s.row >= top && s.row < top + rows) row = s.row;
    if (row == null) return [];
    s.row = row;
    s.cand = null;
    s.steps += 1;
    const code = board.code!;
    const line = lines[row]!;
    // One step per line: never the same line twice in a row.
    if (code.trace[code.trace.length - 1]?.line === line.id) return [];
    return [{ op: 'code.trace', args: { line: line.id, t: now_s() } }];
  };

  return {
    hit(x, y, { board, kit }) {
      const panel = kit.panel;
      const lines = board.code?.lines;
      if (!panel || !lines || !inRect(panel, x, y)) return null;
      const top = topLine(scroll, board, panel);
      const rows = Math.min(lines.length - top, visibleLines(panel));
      const press = ((): CodePress | null => {
        if (top > 0 && inRect(headerRect(panel), x, y)) return { kind: 'scroll', top0: top, page: -1, moved: false };
        if (lines.length > top + rows && inRect(footerRect(panel), x, y)) return { kind: 'scroll', top0: top, page: 1, moved: false };
        if (rows > 0 && inRect(traceMarkerRect(panel, board, top), x, y)) {
          // From the line really traced last, even when it is scrolled away.
          return { kind: 'trace', row: traceIndex(board), cand: null, since: 0, steps: 0, moved: false };
        }
        for (let i = 0; i < rows; i++) {
          if (inRect(codeLineRect(panel, i), x, y)) {
            const l = lines[top + i]!;
            return { kind: 'line', id: l.id, index: top + i, indent: l.indent, locked: locked.has(l.id), axis: null };
          }
        }
        return null;
      })();
      if (press) scroll.live.add(press);
      return press;
    },
    move(press, { board, kit, now_s }) {
      const s = press.state as CodePress;
      if (!kit.panel) return [];
      if (s.kind === 'line') lockAxis(press, s);
      if (s.kind === 'scroll') {
        const dy = press.y - press.start[1];
        if (Math.abs(dy) >= AXIS_LOCK_CM) s.moved = true;
        // The lines follow the hand: pull up to see further down.
        if (s.moved) {
          scroll.top = s.top0 - Math.round(dy / LINE_H);
          scroll.manualAt = scroll.now();
          topLine(scroll, board, kit.panel);
        }
      }
      if (s.kind === 'trace') return traceStep(press, s, board, kit.panel, false, now_s);
      return [];
    },
    cancel(press) {
      scroll.live.delete(press.state);
    },
    up(press, { board, kit, now_s }) {
      const s = press.state as CodePress;
      scroll.live.delete(s);
      const lines = board.code?.lines;
      const panel = kit.panel;
      if (!lines || !panel) return { ops: [] };
      if (s.kind === 'trace') return { ops: traceStep(press, s, board, panel, true, now_s) };
      if (s.kind === 'scroll') {
        if (!s.moved) pageOrCue(scroll, board, panel, s.top0, s.page);
        return { ops: [] };
      }
      lockAxis(press, s);
      if (s.locked || !s.axis) return { ops: [] };
      if (deletesAt(kit, press.x, press.y)) return { ops: [{ op: 'code.delete', args: { id: s.id } }] };
      if (s.axis === 'v') {
        // Up or down by whole lines from where it was pinched, kept inside any locked first and last lines.
        let target = Math.max(0, Math.min(lines.length - 1, s.index + Math.round((press.y - press.start[1]) / LINE_H)));
        if (lines[0] && locked.has(lines[0].id)) target = Math.max(1, target);
        const lastLine = lines[lines.length - 1];
        if (lastLine && locked.has(lastLine.id)) target = Math.min(lines.length - 2, target);
        if (target === s.index) return { ops: [] };
        const rest = lines.filter((l) => l.id !== s.id);
        return { ops: [{ op: 'code.move', args: { id: s.id, after: target === 0 ? null : rest[target - 1]!.id } }] };
      }
      // Sideways: whole levels only, the result kept in 0..6.
      const delta = Math.max(0, Math.min(6, s.indent + indentLevels(press))) - s.indent;
      return { ops: delta !== 0 ? [{ op: 'code.indent', args: { id: s.id, delta } }] : [] };
    },
    overlay(press, board, kit) {
      const s = press.state as CodePress;
      const panel = kit.panel;
      if (!panel || s.kind === 'scroll') return null;
      // On the panel (or just off it) the gesture shows on the panel; past that it follows the hand on the sheet.
      const surface = inRect({ x: panel.x - 3, y: panel.y - 3, w: panel.w + 6, h: panel.h + 6 }, press.x, press.y) ? 'panel' : 'sheet';
      if (s.kind === 'trace') {
        const r = { x: press.start[0] - 1, y: press.y - LINE_H / 2, w: 2, h: LINE_H };
        return {
          key: `trace:${s.row}:${press.y.toFixed(1)}`,
          bounds: r,
          surface,
          draw: (ctx, _b, k) => marker(ctx, r.x + 0.2, r.y, k, ACCENT),
        };
      }
      const line = board.code?.lines.find((l) => l.id === s.id);
      if (!line || !s.axis || s.locked) return null;
      const off = surface === 'sheet';
      const indent = s.axis === 'h' && !off ? Math.max(0, Math.min(6, line.indent + indentLevels(press))) : line.indent;
      const top = topLine(scroll, board, panel);
      const rowY = codeLineRect(panel, s.index - top).y + LINE_H / 2;
      const cx = off || s.axis === 'h' ? press.x : press.start[0];
      const cy = off || s.axis === 'v' ? press.y : rowY;
      const r = { x: cx - 14, y: cy - LINE_H / 2, w: 28, h: LINE_H };
      const overBin = deletesAt(kit, press.x, press.y);
      return {
        key: `line:${s.id}:${r.x.toFixed(1)}:${r.y.toFixed(1)}:${indent}:${overBin}`,
        bounds: r,
        surface,
        overBin,
        draw(ctx, _b, k) {
          ctx.save();
          ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
          ctx.shadowBlur = 0.6 * k;
          roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.3 * k);
          ctx.fillStyle = overBin ? '#5A2A2A' : '#2B3A55';
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = overBin ? '#F08080' : '#6EA8FE';
          ctx.lineWidth = Math.max(1.5, 0.07 * k);
          ctx.stroke();
          ctx.fillStyle = '#F4F6FA';
          ctx.font = `500 ${Math.max(1, CODE_FONT_CM * k)}px ${MONO}`;
          ctx.textBaseline = 'middle';
          ctx.fillText(ellipsize(ctx, line.text, (r.w - 0.8 - indent * INDENT_DRAW) * k), (r.x + 0.4 + indent * INDENT_DRAW) * k, (r.y + LINE_H / 2) * k);
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
export function renderCodePanel(ctx: CanvasRenderingContext2D, board: Board, k: number, panel: Rect, locked: ReadonlySet<string> = new Set(), top = 0, cue: 'below' | 'above' | null = null): void {
  const code = board.code;
  ctx.save();
  roundRect(ctx, panel.x * k, panel.y * k, panel.w * k, panel.h * k, 0.8 * k);
  ctx.fillStyle = '#1E2229';
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.font = font(0.8 * k, 700);
  ctx.textAlign = 'left';
  ctx.fillText(`CODE${code ? `  ·  ${code.language}` : ''}`.toUpperCase(), (panel.x + 0.8) * k, (panel.y + 1.7) * k);
  if (!code) {
    ctx.restore();
    return;
  }
  const n = Math.max(0, Math.min(code.lines.length - top, visibleLines(panel)));
  if (top > 0) {
    ctx.textAlign = 'right';
    if (cue === 'above') ctx.fillStyle = '#6EA8FE';
    ctx.fillText(cue === 'above' ? '▲ New line above' : `▲ ${top} above`, (panel.x + panel.w - 0.8) * k, (panel.y + 1.7) * k);
    ctx.textAlign = 'left';
  }
  if (!code.lines.length) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = font(0.9 * k, 500);
    ctx.fillText('Talk through your code: the lines appear here.', (panel.x + GUTTER) * k, (panel.y + HEADER + 1.2) * k);
  }
  const traced = new Set(code.trace.map((t) => t.line));
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const l: CodeLine = code.lines[top + i]!;
    const r = codeLineRect(panel, i);
    const mid = (r.y + r.h / 2) * k;
    if (i % 2 === 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
    }
    ctx.fillStyle = traced.has(l.id) ? 'rgba(110, 168, 254, 0.95)' : 'rgba(255, 255, 255, 0.45)';
    ctx.font = `500 ${Math.max(1, 0.7 * k)}px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.fillText(String(top + i + 1), (panel.x + GUTTER - 0.3) * k, mid);
    ctx.textAlign = 'left';
    // Indent guides.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = Math.max(1, 0.03 * k);
    for (let d = 1; d <= l.indent; d++) {
      const gx = r.x + 0.4 + (d - 0.5) * INDENT_DRAW;
      ctx.beginPath();
      ctx.moveTo(gx * k, r.y * k);
      ctx.lineTo(gx * k, (r.y + r.h) * k);
      ctx.stroke();
    }
    ctx.fillStyle = locked.has(l.id) ? 'rgba(244, 246, 250, 0.6)' : '#F4F6FA';
    ctx.font = `500 ${Math.max(1, CODE_FONT_CM * k)}px ${MONO}`;
    ctx.fillText(ellipsize(ctx, l.text, (r.w - 0.8 - l.indent * INDENT_DRAW) * k), (r.x + 0.4 + l.indent * INDENT_DRAW) * k, mid);
  }
  ctx.textBaseline = 'alphabetic';
  const below = code.lines.length - top - n;
  if (below > 0) {
    const f = footerRect(panel);
    roundRect(ctx, (f.x + 0.6) * k, (f.y + 0.3) * k, (f.w - 1.2) * k, (f.h - 0.6) * k, 0.4 * k);
    ctx.fillStyle = cue === 'below' ? 'rgba(110, 168, 254, 0.25)' : 'rgba(255, 255, 255, 0.07)';
    ctx.fill();
    ctx.fillStyle = cue === 'below' ? '#FFFFFF' : 'rgba(255, 255, 255, 0.7)';
    ctx.font = font(0.8 * k, 600);
    ctx.textAlign = 'center';
    ctx.fillText(cue === 'below' ? '▼ New line below: pinch to see it' : `▼ ${below} more: pinch here to scroll`, (f.x + f.w / 2) * k, (f.y + f.h / 2 + 0.3) * k);
    ctx.textAlign = 'left';
  }
  if (n) {
    const m = traceMarkerRect(panel, board, top);
    marker(ctx, m.x, m.y, k, code.trace.length ? '#6EA8FE' : 'rgba(110, 168, 254, 0.5)');
  }
  ctx.restore();
}

/**
 * The coding kit. `locked` line ids (the Parsons puzzle's first and last lines) cannot be
 * moved, and nothing can be moved above the first or below the last of them.
 */
export function createCodingKit(opts: { locked?: readonly string[]; now?: () => number } = {}): Kit {
  const locked = new Set(opts.locked ?? []);
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  // Which lines the panel shows: local to this user's view, never board data.
  const scroll: PanelView = { top: 0, anchor: null, manualAt: -Infinity, live: new Set(), code: null, seen: null, cue: null, now };
  const kit: Kit = {
    id: 'coding',
    tray: traySlots(CHIPS.map((value) => ({ name: value, make: { kind: 'chip', value } }))),
    // On the dominant side with the panel, just in front of it.
    bin: { x: SHEET.w + 2, y: PANEL.y + PANEL.h + 0.5, w: 7, h: SHEET.h - PANEL.h - 0.5 },
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
    handler: handler(locked, scroll),
    renderSheet,
    renderPanel(ctx, board, k) {
      if (this.panel) renderCodePanel(ctx, board, k, this.panel, locked, topLine(scroll, board, this.panel), cueSide(scroll, board));
    },
    panelKey(board) {
      const top = this.panel ? topLine(scroll, board, this.panel) : scroll.top;
      return `${top}${scroll.cue ? `:${cueSide(scroll, board)}` : ''}`;
    },
  };
  return kit;
}
