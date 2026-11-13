// Board renderer for a 2D canvas: paper with a faint 2 cm grid, component cards with a
// type icon drawn from canvas paths, edges with arrowheads and mid-edge labels, marker
// ink, Scribe ghosts at 40% with a dashed outline, and the focus ring. The same canvas
// is the headset's board texture, so BoardView redraws only when something changed.
import type { Board, BoardEdge, BoardItem, ComponentType, GhostOp } from '../shared/types';
import type { Overlay } from './input';
import type { GhostRing } from './ghosts';
import type { Kit } from './kits';
import { center, COMPONENT_NAMES, edgeMid, findItem, hasTab, itemRect, tabCenter, type Pt, type Rect } from './model';

export const ACCENT = '#1F4E79';
const PAPER = '#FAF8F3';
const GRID = '#E9E4DA';
const SHEET_EDGE = '#D8D2C6';
const OFF_SHEET = '#EFECE6';
const CARD = '#FFFFFF';
const CARD_EDGE = '#C9CFD8';
const TEXT = '#1C1B1A';
const MUTED = '#6B6760';
const EDGE = '#3A4350';
const INK = '#23272E';
const GHOST_ALPHA = 0.4;
const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
/** Label size: 0.9 cm type on a 1.17 cm line. */
const LABEL_CM = 0.9;
const LINE = 1.3;

export const TYPE_COLORS: Record<ComponentType, string> = {
  client: '#2B5C8A',
  lb: '#0E7C86',
  api_gateway: '#5B4BA0',
  service: '#1F4E79',
  db: '#2E7D4F',
  kv: '#3F7F6B',
  cache: '#B5542D',
  queue: '#8A5A00',
  cdn: '#0F7A9E',
  object_store: '#7A5230',
  search: '#7B3F8C',
  worker: '#50606F',
  external: '#6B6760',
  note: '#9A7800',
  blank: '#8A8F98',
};

export interface RenderView {
  pxPerCm: number;
  /** An item to mark (hover, drop target, the interviewer pointing at it). */
  highlight?: string;
  /** Draw the paper and grid (default true). BoardView caches them separately. */
  paper?: boolean;
  /** An item being dragged: drawn lifted at this offset, its edges following. */
  lift?: { id: string; dx: number; dy: number };
  /** Leave out this item and its edges (BoardView draws a dragged item on its own layer). */
  hide?: string | readonly string[];
  /**
   * Size of the tab and edge chip: 'hand' (default) draws the research 06 sizes (a 2.4 cm
   * tab); 'mouse' draws them smaller. Hit areas are hand sized either way.
   */
  targets?: 'hand' | 'mouse';
}

const TARGET_SIZES = {
  hand: { tab: 1.2, chip: 1.1 },
  mouse: { tab: 0.55, chip: 0.25 },
} as const;

type Ctx = CanvasRenderingContext2D;

// ---------- small drawing helpers (all in pixels) ----------

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const font = (px: number, weight = 400, style = '') => `${style ? style + ' ' : ''}${weight} ${Math.max(1, Math.round(px * 10) / 10)}px ${FONT}`;

const wrapCache = new Map<string, string[]>();
/** Bumped when web fonts finish loading: text measured with a fallback font is stale. */
let fontEpoch = 0;

/** Forget text measured so far and make BoardViews repaint (fonts changed). */
export function onFontsChanged(): void {
  wrapCache.clear();
  fontEpoch += 1;
}

if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.addEventListener === 'function') {
  document.fonts.addEventListener('loadingdone', onFontsChanged);
}

/** Splits text into at most `maxLines` lines no wider than `maxW`, with an ellipsis if cut. Cached. */
function wrap(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const key = `${ctx.font}|${Math.round(maxW)}|${maxLines}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const lines = wrapUncached(ctx, text, maxW, maxLines);
  if (wrapCache.size > 500) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

function wrapUncached(ctx: Ctx, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i]!;
    if (ctx.measureText(next).width <= maxW || !cur) {
      cur = next;
    } else {
      lines.push(cur);
      cur = words[i]!;
      if (lines.length === maxLines) {
        cur = '';
        lines[lines.length - 1] = ellipsize(ctx, `${lines[lines.length - 1]} ${words.slice(i).join(' ')}`, maxW);
        break;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => (ctx.measureText(l).width > maxW ? ellipsize(ctx, l, maxW) : l));
}

function ellipsize(ctx: Ctx, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ---------- icons: drawn in a unit box centred on (cx, cy) ----------

export function drawIcon(ctx: Ctx, type: ComponentType, cx: number, cy: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size, size);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 0.09;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const line = (pts: [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  };
  const dot = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const ring = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  switch (type) {
    case 'client':
      roundRect(ctx, -0.42, -0.38, 0.84, 0.56, 0.07);
      ctx.stroke();
      line([[0, 0.18], [0, 0.34]]);
      line([[-0.2, 0.38], [0.2, 0.38]]);
      break;
    case 'lb':
      dot(0, -0.3, 0.11);
      line([[0, -0.2], [-0.32, 0.26]]);
      line([[0, -0.2], [0, 0.26]]);
      line([[0, -0.2], [0.32, 0.26]]);
      dot(-0.32, 0.32, 0.08);
      dot(0, 0.32, 0.08);
      dot(0.32, 0.32, 0.08);
      break;
    case 'api_gateway':
      ctx.beginPath();
      ctx.moveTo(-0.32, 0.4);
      ctx.lineTo(-0.32, -0.08);
      ctx.arc(0, -0.08, 0.32, Math.PI, 0);
      ctx.lineTo(0.32, 0.4);
      ctx.stroke();
      line([[-0.1, 0.02], [0.08, 0.14], [-0.1, 0.26]]);
      break;
    case 'service': {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const x = 0.42 * Math.cos(a);
        const y = 0.42 * Math.sin(a);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      dot(0, 0, 0.11);
      break;
    }
    case 'db':
      ctx.beginPath();
      ctx.ellipse(0, -0.28, 0.36, 0.12, 0, 0, Math.PI * 2);
      ctx.stroke();
      line([[-0.36, -0.28], [-0.36, 0.28]]);
      line([[0.36, -0.28], [0.36, 0.28]]);
      ctx.beginPath();
      ctx.ellipse(0, 0.28, 0.36, 0.12, 0, 0, Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.36, 0.12, 0, 0, Math.PI);
      ctx.stroke();
      break;
    case 'kv':
      ring(-0.2, 0, 0.18);
      line([[-0.02, 0], [0.42, 0]]);
      line([[0.28, 0], [0.28, 0.15]]);
      line([[0.4, 0], [0.4, 0.12]]);
      break;
    case 'cache':
      ctx.beginPath();
      ctx.moveTo(0.1, -0.46);
      ctx.lineTo(-0.26, 0.06);
      ctx.lineTo(-0.02, 0.06);
      ctx.lineTo(-0.1, 0.46);
      ctx.lineTo(0.26, -0.08);
      ctx.lineTo(0.02, -0.08);
      ctx.closePath();
      ctx.fill();
      break;
    case 'queue':
      for (const x of [-0.44, -0.14, 0.16]) {
        roundRect(ctx, x, -0.24, 0.24, 0.48, 0.05);
        ctx.stroke();
      }
      line([[0.44, -0.1], [0.44, 0.1]]);
      break;
    case 'cdn':
      ring(0, 0, 0.4);
      ctx.beginPath();
      ctx.ellipse(0, 0, 0.17, 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
      line([[-0.4, 0], [0.4, 0]]);
      line([[-0.33, -0.2], [0.33, -0.2]]);
      line([[-0.33, 0.2], [0.33, 0.2]]);
      break;
    case 'object_store':
      ctx.beginPath();
      ctx.moveTo(-0.38, -0.24);
      ctx.lineTo(-0.3, 0.4);
      ctx.lineTo(0.3, 0.4);
      ctx.lineTo(0.38, -0.24);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, -0.24, 0.38, 0.11, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'search':
      ring(-0.08, -0.08, 0.26);
      ctx.lineWidth = 0.13;
      line([[0.12, 0.12], [0.4, 0.4]]);
      break;
    case 'worker':
      ring(0, 0, 0.17);
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        line([[0.27 * Math.cos(a), 0.27 * Math.sin(a)], [0.42 * Math.cos(a), 0.42 * Math.sin(a)]]);
      }
      break;
    case 'external':
      ctx.beginPath();
      ctx.moveTo(-0.3, 0.26);
      ctx.bezierCurveTo(-0.52, 0.26, -0.52, -0.04, -0.3, -0.04);
      ctx.bezierCurveTo(-0.28, -0.34, 0.06, -0.38, 0.13, -0.12);
      ctx.bezierCurveTo(0.32, -0.22, 0.5, -0.02, 0.38, 0.12);
      ctx.bezierCurveTo(0.52, 0.2, 0.44, 0.28, 0.32, 0.26);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'note':
      ctx.beginPath();
      ctx.moveTo(-0.3, -0.4);
      ctx.lineTo(0.14, -0.4);
      ctx.lineTo(0.3, -0.24);
      ctx.lineTo(0.3, 0.4);
      ctx.lineTo(-0.3, 0.4);
      ctx.closePath();
      ctx.stroke();
      line([[-0.16, -0.08], [0.16, -0.08]]);
      line([[-0.16, 0.08], [0.16, 0.08]]);
      line([[-0.16, 0.24], [0.08, 0.24]]);
      break;
    case 'blank':
      ctx.setLineDash([0.12, 0.1]);
      roundRect(ctx, -0.36, -0.36, 0.72, 0.72, 0.08);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function drawTrash(ctx: Ctx, cx: number, cy: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(size, size);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.08;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-0.42, -0.28);
  ctx.lineTo(0.42, -0.28);
  ctx.moveTo(-0.14, -0.28);
  ctx.lineTo(-0.1, -0.42);
  ctx.lineTo(0.1, -0.42);
  ctx.lineTo(0.14, -0.28);
  ctx.moveTo(-0.32, -0.18);
  ctx.lineTo(-0.26, 0.44);
  ctx.lineTo(0.26, 0.44);
  ctx.lineTo(0.32, -0.18);
  ctx.moveTo(-0.1, -0.06);
  ctx.lineTo(-0.08, 0.3);
  ctx.moveTo(0.1, -0.06);
  ctx.lineTo(0.08, 0.3);
  ctx.stroke();
  ctx.restore();
}

// ---------- board pieces ----------

interface Pen {
  ctx: Ctx;
  k: number;
  ghost: boolean;
  focus: string | null;
  targets?: 'hand' | 'mouse';
}

function cardShadow(p: Pen, lifted = false): void {
  if (p.ghost) return;
  p.ctx.shadowColor = lifted ? 'rgba(28, 27, 26, 0.22)' : 'rgba(28, 27, 26, 0.10)';
  p.ctx.shadowBlur = (lifted ? 0.8 : 0.35) * p.k;
  p.ctx.shadowOffsetY = (lifted ? 0.35 : 0.08) * p.k;
}

function noShadow(ctx: Ctx): void {
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/** A white rounded card; ghosts get a dashed outline. */
function cardBody(p: Pen, r: Rect, opts: { fill?: string; edge?: string; radius?: number; lifted?: boolean } = {}): void {
  const { ctx, k } = p;
  ctx.save();
  cardShadow(p, opts.lifted);
  roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, (opts.radius ?? 0.6) * k);
  ctx.fillStyle = opts.fill ?? CARD;
  ctx.fill();
  noShadow(ctx);
  ctx.strokeStyle = p.ghost ? ACCENT : (opts.edge ?? CARD_EDGE);
  ctx.lineWidth = Math.max(1, (p.ghost ? 0.09 : 0.05) * k);
  if (p.ghost) ctx.setLineDash([0.4 * k, 0.3 * k]);
  ctx.stroke();
  ctx.restore();
}

function drawComponent(p: Pen, it: Extract<BoardItem, { kind: 'component' }>, lifted: boolean): void {
  const { ctx, k } = p;
  const r = itemRect(it);
  const color = TYPE_COLORS[it.type];
  cardBody(p, r, { lifted });
  const compact = r.w < 6 || r.h < 4;
  const pad = 0.45;
  const badge = compact ? Math.min(1.3, r.h - 2 * pad) : 1.5;
  const bx = r.x + pad;
  const by = compact ? r.y + (r.h - badge) / 2 : r.y + pad;
  roundRect(ctx, bx * k, by * k, badge * k, badge * k, 0.35 * k);
  ctx.fillStyle = withAlpha(color, 0.12);
  ctx.fill();
  drawIcon(ctx, it.type, (bx + badge / 2) * k, (by + badge / 2) * k, badge * 0.62 * k, color);

  const text = it.label?.trim();
  const tx = compact ? bx + badge + 0.35 : r.x + pad;
  const maxW = (r.x + r.w - pad - tx) * k;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  if (!compact) {
    // Type tag next to the badge.
    ctx.font = font(0.5 * k, 600);
    ctx.fillStyle = MUTED;
    ctx.fillText(ellipsize(ctx, COMPONENT_NAMES[it.type].toUpperCase(), (r.w - 2 * pad - badge - 0.3) * k), (bx + badge + 0.3) * k, (by + badge / 2 + 0.18) * k);
  }
  const notes = it.notes?.length ? it.notes.join(', ') : '';
  const top = compact ? r.y : by + badge;
  const bottom = r.y + r.h - pad - (notes && !compact ? 0.75 : 0);
  const lh = LABEL_CM * LINE;
  const maxLines = Math.max(1, Math.floor((bottom - top - 0.1) / lh));
  ctx.font = font(LABEL_CM * k, text ? 650 : 500, text ? '' : 'italic');
  ctx.fillStyle = text ? TEXT : MUTED;
  const lines = text ? wrap(ctx, text, maxW, compact ? 1 : maxLines) : [p.focus === it.id ? 'Say a name' : 'Unnamed'];
  const blockH = lines.length * lh;
  let y = compact ? r.y + r.h / 2 - blockH / 2 + LABEL_CM * 0.95 : top + Math.max(0.1, (bottom - top - blockH) / 2) + LABEL_CM * 0.95;
  for (const l of lines) {
    ctx.fillText(l, tx * k, y * k);
    y += lh;
  }
  if (notes && !compact) {
    ctx.font = font(0.5 * k, 500);
    ctx.fillStyle = MUTED;
    ctx.fillText(ellipsize(ctx, notes, (r.w - 2 * pad) * k), (r.x + pad) * k, (r.y + r.h - pad) * k);
  }
}

function drawClass(p: Pen, it: Extract<BoardItem, { kind: 'class' }>, lifted: boolean): void {
  const { ctx, k } = p;
  const r = itemRect(it);
  cardBody(p, r, { lifted, radius: 0.4 });
  const pad = 0.45;
  let y = r.y + pad;
  ctx.textAlign = 'center';
  ctx.fillStyle = MUTED;
  if (it.class_kind !== 'class') {
    ctx.font = font(0.5 * k, 500, 'italic');
    y += 0.5;
    ctx.fillText(`«${it.class_kind}»`, (r.x + r.w / 2) * k, y * k);
  }
  ctx.font = font(LABEL_CM * k, 650, it.class_kind === 'abstract' ? 'italic' : '');
  ctx.fillStyle = TEXT;
  y += LABEL_CM;
  ctx.fillText(ellipsize(ctx, it.label ?? 'Unnamed', (r.w - 2 * pad) * k), (r.x + r.w / 2) * k, y * k);
  ctx.textAlign = 'left';
  ctx.font = font(0.55 * k, 450);
  const rule = (yy: number) => {
    ctx.beginPath();
    ctx.moveTo(r.x * k, yy * k);
    ctx.lineTo((r.x + r.w) * k, yy * k);
    ctx.strokeStyle = CARD_EDGE;
    ctx.lineWidth = Math.max(1, 0.04 * k);
    ctx.stroke();
  };
  y += 0.45;
  for (const section of [it.fields, it.methods]) {
    rule(y);
    y += 0.25;
    for (const m of section) {
      y += 0.72;
      if (y > r.y + r.h - 0.2) break;
      const params = m.params ? `(${m.params.map((q) => (q.type ? `${q.name}: ${q.type}` : q.name)).join(', ')})` : '';
      const ty = m.params ? m.returns : m.type;
      ctx.fillStyle = TEXT;
      ctx.fillText(ellipsize(ctx, `${m.vis} ${m.name}${params}${ty ? `: ${ty}` : ''}`, (r.w - 2 * pad) * k), (r.x + pad) * k, y * k);
    }
    y += 0.3;
  }
}

function drawSticky(p: Pen, it: Extract<BoardItem, { kind: 'sticky' }>, lifted: boolean): void {
  const { ctx, k } = p;
  const r = itemRect(it);
  cardBody(p, r, { fill: '#FFE89A', edge: '#E8CF73', radius: 0.25, lifted });
  ctx.font = font(0.75 * k, 550);
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'left';
  const lines = wrap(ctx, it.text, (r.w - 1) * k, Math.max(1, Math.floor(r.h - 1.6)));
  lines.forEach((l, i) => ctx.fillText(l, (r.x + 0.5) * k, (r.y + 1.2 + i) * k));
  for (let i = 0; i < Math.min(it.votes, 8); i++) {
    ctx.beginPath();
    ctx.arc((r.x + r.w - 0.6 - i * 0.55) * k, (r.y + r.h - 0.55) * k, 0.18 * k, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
  }
}

function drawGroup(p: Pen, it: Extract<BoardItem, { kind: 'group' }>): void {
  const { ctx, k } = p;
  const r = itemRect(it);
  ctx.save();
  roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.8 * k);
  ctx.fillStyle = withAlpha(ACCENT, 0.04);
  ctx.fill();
  ctx.setLineDash([0.5 * k, 0.35 * k]);
  ctx.strokeStyle = '#98A2AE';
  ctx.lineWidth = Math.max(1, 0.06 * k);
  ctx.stroke();
  ctx.restore();
  if (it.label) {
    ctx.font = font(0.6 * k, 600);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, it.label, (r.w - 1) * k), (r.x + 0.5) * k, (r.y + 0.95) * k);
  }
}

function drawMetric(p: Pen, it: Extract<BoardItem, { kind: 'metric' }>, lifted: boolean): void {
  const { ctx, k } = p;
  const r = itemRect(it);
  cardBody(p, r, { radius: r.h / 2, lifted, edge: it.role === 'north_star' ? ACCENT : CARD_EDGE });
  ctx.textAlign = 'left';
  ctx.font = font(0.45 * k, 650);
  ctx.fillStyle = MUTED;
  ctx.fillText(it.role.replace('_', ' ').toUpperCase(), (r.x + 0.9) * k, (r.y + 1.2) * k);
  ctx.font = font(0.8 * k, 650);
  ctx.fillStyle = TEXT;
  ctx.fillText(ellipsize(ctx, it.label ?? 'Unnamed', (r.w - 1.8) * k), (r.x + 0.9) * k, (r.y + 2.4) * k);
}

function drawInterviewerCard(p: Pen, it: Extract<BoardItem, { kind: 'interviewer_card' }>, lifted: boolean): void {
  const { ctx, k } = p;
  const r = itemRect(it);
  cardBody(p, r, { lifted, radius: 0.4 });
  ctx.fillStyle = ACCENT;
  ctx.fillRect(r.x * k, (r.y + 0.4) * k, 0.18 * k, (r.h - 0.8) * k);
  ctx.textAlign = 'left';
  ctx.font = font(0.7 * k, 700);
  ctx.fillStyle = TEXT;
  ctx.fillText(ellipsize(ctx, it.title, (r.w - 1.2) * k), (r.x + 0.7) * k, (r.y + 1.3) * k);
  ctx.font = font(0.6 * k, 450);
  ctx.fillStyle = MUTED;
  wrap(ctx, it.body, (r.w - 1.2) * k, Math.max(1, Math.floor((r.h - 2) / 0.85))).forEach((l, i) =>
    ctx.fillText(l, (r.x + 0.7) * k, (r.y + 2.3 + i * 0.85) * k),
  );
}

/** Ink through the midpoints of its points, so the simplified polyline reads as a smooth stroke. */
function inkPath(ctx: Ctx, pts: readonly Pt[], k: number): void {
  ctx.beginPath();
  if (pts.length === 0) return;
  ctx.moveTo(pts[0]![0] * k, pts[0]![1] * k);
  if (pts.length < 3) {
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x * k, y * k);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    ctx.quadraticCurveTo(x * k, y * k, ((x + nx) / 2) * k, ((y + ny) / 2) * k);
  }
  const last = pts[pts.length - 1]!;
  ctx.lineTo(last[0] * k, last[1] * k);
}

function drawInk(p: Pen, pts: readonly Pt[], color = INK): void {
  const { ctx, k } = p;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, 0.3 * k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (p.ghost) ctx.setLineDash([0.4 * k, 0.3 * k]);
  inkPath(ctx, pts, k);
  ctx.stroke();
  ctx.restore();
}

function drawTab(p: Pen, it: BoardItem): void {
  const { ctx, k } = p;
  const [tx, ty] = tabCenter(it);
  const r = TARGET_SIZES[p.targets ?? 'hand'].tab;
  const active = p.focus === it.id;
  ctx.beginPath();
  ctx.arc(tx * k, ty * k, r * k, 0, Math.PI * 2);
  ctx.fillStyle = CARD;
  ctx.fill();
  ctx.strokeStyle = active ? ACCENT : CARD_EDGE;
  ctx.lineWidth = Math.max(1, 0.06 * k);
  ctx.stroke();
  // A small arrow: pull from here to connect.
  ctx.save();
  ctx.strokeStyle = active ? ACCENT : '#98A2AE';
  ctx.lineWidth = Math.max(1, r * 0.16 * k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const a = r * 0.42;
  ctx.beginPath();
  ctx.moveTo((tx - a) * k, (ty + a) * k);
  ctx.lineTo((tx + a) * k, (ty - a) * k);
  ctx.moveTo((tx + a * 0.1) * k, (ty - a) * k);
  ctx.lineTo((tx + a) * k, (ty - a) * k);
  ctx.lineTo((tx + a) * k, (ty - a * 0.1) * k);
  ctx.stroke();
  ctx.restore();
}

function drawItem(p: Pen, it: BoardItem, lifted = false): void {
  switch (it.kind) {
    case 'component':
      drawComponent(p, it, lifted);
      break;
    case 'class':
      drawClass(p, it, lifted);
      break;
    case 'sticky':
      drawSticky(p, it, lifted);
      break;
    case 'group':
      drawGroup(p, it);
      break;
    case 'metric':
      drawMetric(p, it, lifted);
      break;
    case 'interviewer_card':
      drawInterviewerCard(p, it, lifted);
      break;
    case 'ink':
      drawInk(p, it.points);
      return;
  }
  if (!p.ghost && hasTab(it)) drawTab(p, it);
}

/** Where the line from a rect's centre towards (tx, ty) leaves the rect, plus a small gap. */
function exitPoint(r: Rect, tx: number, ty: number, gap: number): Pt {
  const [cx, cy] = center(r);
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Infinity : (r.w / 2 + gap) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (r.h / 2 + gap) / Math.abs(dy);
  const s = Math.min(sx, sy, 1);
  return [cx + dx * s, cy + dy * s];
}

function arrowHead(p: Pen, tip: Pt, from: Pt, color: string): void {
  const { ctx, k } = p;
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const len = 0.9;
  const half = 0.38;
  const bx = tip[0] - len * Math.cos(ang);
  const by = tip[1] - len * Math.sin(ang);
  ctx.beginPath();
  ctx.moveTo(tip[0] * k, tip[1] * k);
  ctx.lineTo((bx + half * Math.sin(ang)) * k, (by - half * Math.cos(ang)) * k);
  ctx.lineTo((bx - half * Math.sin(ang)) * k, (by + half * Math.cos(ang)) * k);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.fill();
}

function labelPill(p: Pen, text: string, at: Pt, opts: { color?: string; dashed?: boolean } = {}): void {
  const { ctx, k } = p;
  ctx.font = font(0.6 * k, 600);
  const t = ellipsize(ctx, text, 12 * k);
  const w = ctx.measureText(t).width + 0.6 * k;
  const h = 0.95 * k;
  ctx.save();
  roundRect(ctx, at[0] * k - w / 2, at[1] * k - h / 2, w, h, h / 2);
  ctx.fillStyle = PAPER;
  ctx.fill();
  ctx.strokeStyle = opts.color ?? CARD_EDGE;
  ctx.lineWidth = Math.max(1, 0.05 * k);
  if (opts.dashed) ctx.setLineDash([0.3 * k, 0.2 * k]);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = opts.color ?? TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, at[0] * k, at[1] * k + 0.04 * k);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

function drawEdge(p: Pen, board: Board, e: Pick<BoardEdge, 'from' | 'to' | 'dir' | 'label' | 'rel'>): void {
  const a = findItem(board, e.from);
  const b = findItem(board, e.to);
  if (!a || !b) return;
  const { ctx, k } = p;
  const ra = itemRect(a);
  const rb = itemRect(b);
  const [bcx, bcy] = center(rb);
  const [acx, acy] = center(ra);
  const start = exitPoint(ra, bcx, bcy, 0.15);
  const end = exitPoint(rb, acx, acy, 0.15);
  const color = p.ghost ? ACCENT : EDGE;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, 0.1 * k);
  ctx.lineCap = 'round';
  if (p.ghost || e.rel === 'implements') ctx.setLineDash([0.45 * k, 0.3 * k]);
  ctx.beginPath();
  ctx.moveTo(start[0] * k, start[1] * k);
  ctx.lineTo(end[0] * k, end[1] * k);
  ctx.stroke();
  ctx.setLineDash([]);
  if (e.dir === '->' || e.dir === '<->') arrowHead(p, end, start, color);
  if (e.dir === '<->') arrowHead(p, start, end, color);
  ctx.restore();
  const mid = edgeMid(board, e) ?? [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  if (e.label) {
    labelPill(p, e.label, mid, { color: p.ghost ? ACCENT : undefined, dashed: p.ghost });
  } else if (!p.ghost) {
    // The chip you tap to change the direction.
    ctx.beginPath();
    ctx.arc(mid[0] * k, mid[1] * k, TARGET_SIZES[p.targets ?? 'hand'].chip * k, 0, Math.PI * 2);
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.strokeStyle = withAlpha(EDGE, 0.45);
    ctx.lineWidth = Math.max(1, 0.06 * k);
    ctx.stroke();
    // Inside: the direction it has now (chevrons, so tapping reads as "change the arrow").
    const r = TARGET_SIZES[p.targets ?? 'hand'].chip;
    const ang = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const chevron = (dir: number, off: number) => {
      const a = ang + (dir < 0 ? Math.PI : 0);
      const cx = mid[0] + off * Math.cos(ang);
      const cy = mid[1] + off * Math.sin(ang);
      const s2 = r * 0.32;
      ctx.beginPath();
      ctx.moveTo((cx - s2 * Math.cos(a) + s2 * Math.sin(a)) * k, (cy - s2 * Math.sin(a) - s2 * Math.cos(a)) * k);
      ctx.lineTo(cx * k, cy * k);
      ctx.lineTo((cx - s2 * Math.cos(a) - s2 * Math.sin(a)) * k, (cy - s2 * Math.sin(a) + s2 * Math.cos(a)) * k);
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, r * 0.14 * k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (e.dir === '->') chevron(1, r * 0.15);
    else if (e.dir === '<->') {
      chevron(1, r * 0.35);
      chevron(-1, -r * 0.35);
    } else {
      ctx.beginPath();
      ctx.moveTo((mid[0] - r * 0.4 * Math.cos(ang)) * k, (mid[1] - r * 0.4 * Math.sin(ang)) * k);
      ctx.lineTo((mid[0] + r * 0.4 * Math.cos(ang)) * k, (mid[1] + r * 0.4 * Math.sin(ang)) * k);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function ring(p: Pen, r: Rect, color: string, width: number, outset: number): void {
  const { ctx, k } = p;
  ctx.save();
  roundRect(ctx, (r.x - outset) * k, (r.y - outset) * k, (r.w + 2 * outset) * k, (r.h + 2 * outset) * k, (0.6 + outset) * k);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, width * k);
  ctx.stroke();
  ctx.restore();
}

/** Paper, sheet edge and the 2 cm grid. */
export function renderPaper(ctx: Ctx, board: Board, pxPerCm: number): void {
  const k = pxPerCm;
  const { w, h } = board.size;
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w * k, h * k);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = Math.max(1, 0.03 * k);
  ctx.beginPath();
  for (let x = 2; x < w; x += 2) {
    ctx.moveTo(Math.round(x * k) + 0.5, 0);
    ctx.lineTo(Math.round(x * k) + 0.5, h * k);
  }
  for (let y = 2; y < h; y += 2) {
    ctx.moveTo(0, Math.round(y * k) + 0.5);
    ctx.lineTo(w * k, Math.round(y * k) + 0.5);
  }
  ctx.stroke();
  ctx.strokeStyle = SHEET_EDGE;
  ctx.lineWidth = Math.max(1, 0.06 * k);
  ctx.strokeRect(0, 0, w * k, h * k);
  ctx.restore();
}

function ghostItems(board: Board): BoardItem[] {
  return board.ghosts.filter((g): g is Extract<GhostOp, { op: 'item.create' }> => g.op === 'item.create').map((g) => g.args);
}

function moved(board: Board, lift: RenderView['lift']): { board: Board; item: BoardItem | null } {
  if (!lift) return { board, item: null };
  const idx = board.items.findIndex((i) => i.id === lift.id);
  if (idx < 0) return { board, item: null };
  const it = board.items[idx]!;
  const next: BoardItem =
    it.kind === 'ink'
      ? { ...it, points: it.points.map(([x, y]) => [x + lift.dx, y + lift.dy] as Pt) }
      : ({ ...it, x: it.x + lift.dx, y: it.y + lift.dy } as BoardItem);
  const items = board.items.slice();
  items[idx] = next;
  return { board: { ...board, items }, item: next };
}

/**
 * Draws the board with its top-left corner at the context origin, `pxPerCm` pixels per
 * board centimetre.
 */
export function renderBoard(ctx: Ctx, board0: Board, view: RenderView): void {
  const k = view.pxPerCm;
  const { board, item: lifted } = moved(board0, view.lift);
  const pen: Pen = { ctx, k, ghost: false, focus: board.focus, targets: view.targets };
  const skipIds = new Set<string>(typeof view.hide === 'string' ? [view.hide] : (view.hide ?? []));
  if (lifted) skipIds.add(lifted.id);
  const skipped = (id: string) => skipIds.has(id);
  ctx.save();
  if (view.paper !== false) renderPaper(ctx, board, k);

  for (const it of board.items) if (it.kind === 'group' && !skipped(it.id)) drawItem(pen, it);
  for (const e of board.edges) if (!skipped(e.from) && !skipped(e.to)) drawEdge(pen, board, e);
  for (const it of board.items) if (it.kind !== 'group' && it.kind !== 'ink' && !skipped(it.id)) drawItem(pen, it);
  for (const it of board.items) if (it.kind === 'ink' && !skipped(it.id)) drawItem(pen, it);

  // Scribe suggestions: faded, dashed, on top of what is committed.
  if (board.ghosts.length) {
    const withGhosts: Board = { ...board, items: [...board.items, ...ghostItems(board)] };
    const gp: Pen = { ...pen, ghost: true };
    for (const g of board.ghosts) {
      ctx.save();
      ctx.globalAlpha = GHOST_ALPHA;
      drawGhost(gp, withGhosts, g);
      ctx.restore();
    }
  }

  if (view.highlight && !skipped(view.highlight)) {
    const h = findItem(board, view.highlight);
    if (h && h.kind !== 'ink') ring(pen, itemRect(h), withAlpha(ACCENT, 0.35), 0.35, 0.3);
  }
  const f = findItem(board, board.focus);
  if (f && f.kind !== 'ink' && !skipped(f.id)) ring(pen, itemRect(f), ACCENT, 0.16, 0.3);

  if (lifted) drawLifted(pen, board, lifted, false);
  ctx.restore();
}

/** A dragged item and the edges that follow it, lifted with a stronger shadow. */
function drawLifted(pen: Pen, board: Board, lifted: BoardItem, dim: boolean): void {
  const { ctx } = pen;
  ctx.save();
  if (dim) ctx.globalAlpha = 0.45;
  for (const e of board.edges) if (e.from === lifted.id || e.to === lifted.id) drawEdge(pen, board, e);
  drawItem(pen, lifted, true);
  if (board.focus === lifted.id && lifted.kind !== 'ink') ring(pen, itemRect(lifted), ACCENT, 0.16, 0.3);
  ctx.restore();
}

/**
 * Only the dragged item (at its offset) and its edges, for the live layer while the rest
 * of the board stays cached. Ink being dragged is dimmed unless it is over the bin, since
 * ink cannot move and goes back on release.
 */
export function renderLift(ctx: Ctx, board0: Board, lift: { id: string; dx: number; dy: number; dim?: boolean }, view: Pick<RenderView, 'pxPerCm' | 'targets'>): void {
  const { board, item } = moved(board0, lift);
  if (!item) return;
  drawLifted({ ctx, k: view.pxPerCm, ghost: false, focus: board.focus, targets: view.targets }, board, item, lift.dim === true);
}

const verbPill = (p: Pen, text: string, at: Pt) => labelPill(p, text, at, { color: ACCENT, dashed: true });

function dashedOutline(p: Pen, r: Rect, color = ACCENT): void {
  const { ctx, k } = p;
  ctx.save();
  roundRect(ctx, r.x * k, r.y * k, r.w * k, r.h * k, 0.6 * k);
  ctx.setLineDash([0.4 * k, 0.3 * k]);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, 0.1 * k);
  ctx.stroke();
  ctx.restore();
}

/** A Scribe suggestion drawn where it would land, with a small verb pill for changes. */
function drawGhost(p: Pen, board: Board, g: GhostOp): void {
  const below = (r: Rect): Pt => [r.x + r.w / 2, r.y + r.h + 0.9];
  switch (g.op) {
    case 'item.create':
      drawItem(p, g.args);
      return;
    case 'edge.create':
      drawEdge(p, board, { from: g.args.from, to: g.args.to, dir: g.args.dir ?? '->', label: g.args.label ?? null, rel: g.args.rel ?? null });
      return;
    case 'group.create':
      dashedOutline(p, g.args);
      if (g.args.label) verbPill(p, g.args.label, [g.args.x + g.args.w / 2, g.args.y + 0.9]);
      return;
    case 'item.label':
    case 'item.note.add': {
      const it = findItem(board, g.args.id);
      if (!it || !g.args.text) return;
      verbPill(p, g.args.text, below(itemRect(it)));
      return;
    }
    case 'item.move': {
      const it = findItem(board, g.args.id);
      if (!it) return;
      const r = itemRect(it);
      const to = { ...r, x: g.args.x, y: g.args.y };
      dashedOutline(p, to);
      verbPill(p, 'Move here', [to.x + to.w / 2, to.y + to.h / 2]);
      return;
    }
    case 'item.delete': {
      const it = findItem(board, g.args.id);
      if (!it) return;
      const r = itemRect(it);
      dashedOutline(p, { x: r.x - 0.3, y: r.y - 0.3, w: r.w + 0.6, h: r.h + 0.6 }, '#A23B2A');
      verbPill(p, 'Delete', below(r));
      return;
    }
    case 'item.set_type': {
      const it = findItem(board, g.args.id);
      if (!it) return;
      const t = g.args.type;
      const name = t in COMPONENT_NAMES ? COMPONENT_NAMES[t as ComponentType] : t.replace('_', ' ');
      verbPill(p, `Make it ${name}`, below(itemRect(it)));
      return;
    }
    case 'sticky.vote':
    case 'sticky.set_quad': {
      const it = findItem(board, g.args.id);
      if (!it) return;
      verbPill(p, g.op === 'sticky.vote' ? (g.args.delta > 0 ? 'Vote' : 'Unvote') : `Quadrant ${g.args.quad ?? 'none'}`, below(itemRect(it)));
      return;
    }
    case 'edge.label':
    case 'edge.set_dir':
    case 'edge.set_rel':
    case 'edge.delete': {
      const e = board.edges.find((x) => x.id === g.args.id);
      const m = e && edgeMid(board, e);
      if (!m) return;
      const text =
        g.op === 'edge.label'
          ? g.args.text
          : g.op === 'edge.set_dir'
            ? `Arrow ${g.args.dir}`
            : g.op === 'edge.set_rel'
              ? `Relation ${(g.args.rel ?? 'none').replace('_', ' ')}`
              : 'Delete';
      if (text) verbPill(p, text, [m[0], m[1] + 1.1]);
      return;
    }
    default:
      return;
  }
}

// ---------- around the sheet: tray, bin, live gestures ----------

/** The tray of cards (and the bin), in board cm (the tray sits at negative x). */
export function renderKit(ctx: Ctx, kit: Kit, pxPerCm: number, state: { binHot?: boolean; bin?: boolean } = {}): void {
  const k = pxPerCm;
  const pen: Pen = { ctx, k, ghost: false, focus: null };
  ctx.save();
  for (const s of kit.tray) {
    const color = TYPE_COLORS[s.type];
    cardBody(pen, s, { radius: 0.45 });
    const b = s.h - 0.7;
    roundRect(ctx, (s.x + 0.35) * k, (s.y + 0.35) * k, b * k, b * k, 0.25 * k);
    ctx.fillStyle = withAlpha(color, 0.12);
    ctx.fill();
    drawIcon(ctx, s.type, (s.x + 0.35 + b / 2) * k, (s.y + s.h / 2) * k, b * 0.64 * k, color);
    ctx.font = font(0.62 * k, 600);
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, s.name, (s.w - b - 1.1) * k), (s.x + b + 0.75) * k, (s.y + s.h / 2 + 0.04) * k);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  if (state.bin !== false) renderBin(ctx, kit, k, state.binHot === true);
}

/** The bin; red while something is held over it. */
export function renderBin(ctx: Ctx, kit: Kit, pxPerCm: number, hot: boolean): void {
  const k = pxPerCm;
  const bin = kit.bin;
  ctx.save();
  roundRect(ctx, bin.x * k, bin.y * k, bin.w * k, bin.h * k, 0.8 * k);
  ctx.fillStyle = hot ? '#F4E3DF' : OFF_SHEET;
  ctx.fill();
  ctx.setLineDash([0.4 * k, 0.3 * k]);
  ctx.strokeStyle = hot ? '#A23B2A' : '#B9B2A6';
  ctx.lineWidth = Math.max(1, 0.06 * k);
  ctx.stroke();
  ctx.setLineDash([]);
  drawTrash(ctx, (bin.x + bin.w / 2) * k, (bin.y + bin.h / 2) * k, 2.6 * k, hot ? '#A23B2A' : MUTED);
  ctx.restore();
}

/**
 * Live gestures on top of the board: the stroke being drawn, the connector, a card from
 * the tray, a dragged item (lifted, with its edges).
 */
export function renderOverlay(ctx: Ctx, board: Board, overlay: Overlay, kit: Kit | null, pxPerCm: number, targets?: 'hand' | 'mouse'): void {
  const k = pxPerCm;
  const pen: Pen = { ctx, k, ghost: false, focus: board.focus, targets };
  switch (overlay.kind) {
    case 'ink':
      drawInk(pen, overlay.points);
      return;
    case 'drag':
      renderLift(ctx, board, { id: overlay.id, dx: overlay.dx, dy: overlay.dy, dim: overlay.ink && !overlay.overBin }, { pxPerCm: k, targets });
      return;
    case 'connect': {
      const from = findItem(board, overlay.from);
      if (!from) return;
      const target = findItem(board, overlay.target);
      const start = tabCenter(from);
      const end: Pt = target ? exitPoint(itemRect(target), start[0], start[1], 0.15) : [overlay.x, overlay.y];
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = Math.max(1.5, 0.12 * k);
      ctx.setLineDash([0.4 * k, 0.25 * k]);
      ctx.beginPath();
      ctx.moveTo(start[0] * k, start[1] * k);
      ctx.lineTo(end[0] * k, end[1] * k);
      ctx.stroke();
      ctx.setLineDash([]);
      arrowHead(pen, end, start, ACCENT);
      ctx.restore();
      if (target) ring(pen, itemRect(target), withAlpha(ACCENT, 0.45), 0.35, 0.3);
      return;
    }
    case 'tray': {
      const w = kit?.card.w ?? 8;
      const h = kit?.card.h ?? 5;
      const it: BoardItem = { id: '_tray', kind: 'component', type: overlay.type, label: null, x: overlay.x - w / 2, y: overlay.y - h / 2, w, h };
      ctx.save();
      ctx.globalAlpha = overlay.onSheet ? 0.9 : 0.5;
      drawComponent(pen, it, true);
      ctx.restore();
      return;
    }
    default:
      return;
  }
}

/** Board cm bounds a live overlay touches (for dirty rects), or null when it draws nothing. */
export function overlayBounds(board: Board, o: Overlay, kit: Kit | null): Rect | null {
  const pad = 1.5;
  const grow = (r: Rect): Rect => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
  const union = (rs: Rect[]): Rect | null => {
    if (!rs.length) return null;
    const x0 = Math.min(...rs.map((r) => r.x));
    const y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w));
    const y1 = Math.max(...rs.map((r) => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  const pts = (ps: readonly Pt[]): Rect | null => union(ps.map(([x, y]) => ({ x, y, w: 0, h: 0 })));
  switch (o.kind) {
    case 'none':
      return null;
    case 'ink': {
      const r = pts(o.points);
      return r && grow(r);
    }
    case 'drag': {
      const { board: b, item } = moved(board, { id: o.id, dx: o.dx, dy: o.dy });
      if (!item) return null;
      const rs = [itemRect(item)];
      for (const e of b.edges) {
        if (e.from !== o.id && e.to !== o.id) continue;
        const a = findItem(b, e.from);
        const c = findItem(b, e.to);
        if (a && c) rs.push(itemRect(a), itemRect(c));
      }
      if (kit) rs.push(kit.bin);
      return grow(union(rs)!);
    }
    case 'connect': {
      const from = findItem(board, o.from);
      if (!from) return null;
      const target = findItem(board, o.target);
      const rs = [pts([tabCenter(from), [o.x, o.y]])!];
      if (target) rs.push(itemRect(target));
      return grow(union(rs)!);
    }
    case 'tray': {
      const w = kit?.card.w ?? 8;
      const h = kit?.card.h ?? 5;
      const rs = [{ x: o.x - w / 2, y: o.y - h / 2, w, h }];
      if (kit) rs.push(kit.bin);
      return grow(union(rs)!);
    }
  }
}

// ---------- the cached view ----------

type Layer = HTMLCanvasElement | OffscreenCanvas;

export interface BoardViewOptions {
  pxPerCm: number;
  /** Board cm shown at the canvas's top-left corner (negative to show the tray). */
  originCm: { x: number; y: number };
  widthCm: number;
  heightCm: number;
  kit?: Kit | null;
  /** Device pixels per CSS pixel. */
  dpr?: number;
  /** Tab and chip drawing size (hit areas are hand sized either way). */
  targets?: 'hand' | 'mouse';
  /** Makes the offscreen layers; null draws everything every time. */
  layerFactory?: (w: number, h: number) => Layer | null;
}

export interface DrawState {
  highlight?: string | null;
  overlays?: Overlay[];
  /** Ghost settle rings (GhostLayer.rings), drawn live. */
  rings?: GhostRing[];
  /** false: overlays only decide what is lifted out of the board layer; the caller draws them elsewhere. */
  drawLive?: boolean;
}

/**
 * The pinch shadow: a ring on the sheet under a hand's pinch point that tightens as the hand
 * comes down, filled while pinched (research 06 §2.5).
 */
export function renderPinchShadow(ctx: Ctx, p: { x_cm: number; y_cm: number; h_cm: number; pinched: boolean }, pxPerCm: number): void {
  const k = pxPerCm;
  const r = 0.45 + Math.min(Math.max(p.h_cm, 0), 8) * 0.1;
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x_cm * k, p.y_cm * k, r * k, 0, Math.PI * 2);
  if (p.pinched) {
    ctx.fillStyle = withAlpha(ACCENT, 0.35);
    ctx.fill();
  }
  ctx.strokeStyle = withAlpha(ACCENT, 0.6);
  ctx.lineWidth = Math.max(1, 0.1 * k);
  ctx.stroke();
  ctx.restore();
}

/** A small ring at a ghost that fills over its 4 s settle. */
export function renderGhostRing(ctx: Ctx, ring: GhostRing, pxPerCm: number): void {
  const k = pxPerCm;
  const r = 0.75;
  ctx.save();
  ctx.beginPath();
  ctx.arc(ring.x * k, ring.y * k, r * k, 0, Math.PI * 2);
  ctx.fillStyle = PAPER;
  ctx.fill();
  ctx.strokeStyle = withAlpha(ACCENT, 0.25);
  ctx.lineWidth = Math.max(1.5, 0.18 * k);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ring.x * k, ring.y * k, r * k, -Math.PI / 2, -Math.PI / 2 + ring.progress * Math.PI * 2);
  ctx.strokeStyle = ACCENT;
  ctx.stroke();
  ctx.restore();
}

/** Ring progress in 5% steps, so a settle redraws 20 times, not every frame. */
export const ringKey = (rs: readonly GhostRing[]) => rs.map((r) => `${r.op_id}:${Math.floor(r.progress * 20)}`).join(',');

function defaultLayer(w: number, h: number): Layer | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

export function overlayKey(o: Overlay): string {
  switch (o.kind) {
    case 'none':
      return 'none';
    case 'ink': {
      const last = o.points[o.points.length - 1];
      return `ink:${o.hand}:${o.points.length}:${last?.[0]}:${last?.[1]}`;
    }
    case 'drag':
      return `drag:${o.id}:${o.dx}:${o.dy}:${o.overBin}`;
    case 'connect':
      return `connect:${o.from}:${o.x}:${o.y}:${o.target}`;
    case 'tray':
      return `tray:${o.type}:${o.x}:${o.y}:${o.onSheet}:${o.overBin}`;
  }
}

/**
 * A canvas showing one board (plus the kit around it), in three layers:
 * - static: paper, grid, tray and bin; painted once per size and framing;
 * - board: the committed board; painted only when the board, highlight or the dragged
 *   item changes (the dragged item is left out of it);
 * - live: the gesture (stroke, dragged item with its edges, connector, tray card), drawn
 *   on top every time it changes.
 * draw() returns false and touches nothing when nothing changed, and `dirty` says which
 * canvas pixels changed, so a headset texture can upload only that part.
 */
export class BoardView {
  private opts: Required<Omit<BoardViewOptions, 'kit'>> & { kit: Kit | null };
  private staticLayer: Layer | null = null;
  private staticKey = '';
  private boardLayer: Layer | null = null;
  private boardKey = '';
  private boardOf: Board | null = null;
  private lastBoard: Board | null = null;
  private lastKey = '';
  private lastLive: Rect | null = null;
  /** Canvas pixels changed by the last draw() that returned true (whole canvas when unknown). */
  dirty: { x: number; y: number; w: number; h: number } | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: BoardViewOptions,
  ) {
    this.opts = { dpr: 1, kit: null, targets: 'hand', layerFactory: defaultLayer, ...opts };
    this.size();
  }

  /** Changes scale or framing; the next draw repaints everything. */
  configure(patch: Partial<BoardViewOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.size();
    this.lastBoard = null;
    this.boardKey = '';
  }

  private size(): void {
    const { pxPerCm, widthCm, heightCm, dpr } = this.opts;
    const w = Math.round(widthCm * pxPerCm * dpr);
    const h = Math.round(heightCm * pxPerCm * dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /** Canvas CSS pixel to board cm. */
  toBoard(px: number, py: number): Pt {
    return [px / this.opts.pxPerCm + this.opts.originCm.x, py / this.opts.pxPerCm + this.opts.originCm.y];
  }

  /** Board cm to canvas CSS pixel. */
  toPx(x: number, y: number): Pt {
    return [(x - this.opts.originCm.x) * this.opts.pxPerCm, (y - this.opts.originCm.y) * this.opts.pxPerCm];
  }

  private paintStatic(c: Ctx, board: Board): void {
    const { pxPerCm: k, originCm, widthCm, heightCm, kit } = this.opts;
    c.fillStyle = OFF_SHEET;
    c.fillRect(0, 0, widthCm * k, heightCm * k);
    c.save();
    c.translate(-originCm.x * k, -originCm.y * k);
    renderPaper(c, board, k);
    if (kit) renderKit(c, kit, k);
    c.restore();
  }

  private paintBoard(c: Ctx, board: Board, highlight: string | null, hide: readonly string[]): void {
    const { pxPerCm: k, originCm, targets } = this.opts;
    c.save();
    c.translate(-originCm.x * k, -originCm.y * k);
    renderBoard(c, board, { pxPerCm: k, paper: false, highlight: highlight ?? undefined, hide, targets });
    c.restore();
  }

  private layerCtx(layer: Layer | null): Ctx | null {
    const c = (layer?.getContext('2d') as Ctx | null | undefined) ?? null;
    if (c) c.setTransform(this.opts.dpr, 0, 0, this.opts.dpr, 0, 0);
    return c;
  }

  private blit(ctx: Ctx, layer: Layer): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer as CanvasImageSource, 0, 0);
    ctx.setTransform(this.opts.dpr, 0, 0, this.opts.dpr, 0, 0);
  }

  draw(board: Board, state: DrawState = {}): boolean {
    const overlays = state.overlays ?? [];
    const highlight = state.highlight ?? null;
    const rings = state.rings ?? [];
    const drawLive = state.drawLive !== false;
    const key = `${highlight ?? ''}|${drawLive ? overlays.map(overlayKey).join('|') : overlays.flatMap((o) => (o.kind === 'drag' ? [o.id] : [])).sort().join('|')}|${drawLive ? ringKey(rings) : ''}|${fontEpoch}`;
    if (board === this.lastBoard && key === this.lastKey) return false;
    this.lastBoard = board;
    this.lastKey = key;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return false;
    const { pxPerCm: k, originCm, dpr, kit, targets } = this.opts;
    // Every dragged item (one per hand) is left out of the board layer and drawn live.
    const dragIds = overlays.flatMap((o) => (o.kind === 'drag' ? [o.id] : [])).sort();
    const binHot = overlays.some((o) => (o.kind === 'drag' || o.kind === 'tray') && o.overBin);

    // Static layer: once per size and framing.
    const sk = `${this.canvas.width}x${this.canvas.height}:${k}:${dpr}:${originCm.x},${originCm.y}:${board.size.w}x${board.size.h}:${kit ? `${kit.id}:${kit.tray.length}:${kit.bin.x},${kit.bin.y}` : '-'}`;
    if (this.staticKey !== sk) {
      this.staticLayer = this.opts.layerFactory(this.canvas.width, this.canvas.height);
      this.boardLayer = this.opts.layerFactory(this.canvas.width, this.canvas.height);
      const sc = this.layerCtx(this.staticLayer);
      if (sc) this.paintStatic(sc, board);
      else this.staticLayer = null;
      this.staticKey = sk;
      this.boardKey = '';
    }

    // Board layer: only when the committed board, highlight or dragged item changes.
    const bk = `${highlight ?? ''}|${dragIds.join(',')}|${fontEpoch}`;
    let full = false;
    if (board !== this.boardOf || bk !== this.boardKey) {
      const bc = this.staticLayer ? this.layerCtx(this.boardLayer) : null;
      if (bc && this.staticLayer) {
        this.blit(bc, this.staticLayer);
        this.paintBoard(bc, board, highlight, dragIds);
        this.boardOf = board;
        this.boardKey = bk;
      }
      full = true;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.boardLayer && this.boardOf === board && this.boardKey === bk && this.staticLayer) {
      this.blit(ctx, this.boardLayer);
    } else {
      // No offscreen layers here: paint everything.
      this.paintStatic(ctx, board);
      this.paintBoard(ctx, board, highlight, dragIds);
      full = true;
    }

    // Live layer: the gestures.
    ctx.save();
    ctx.translate(-originCm.x * k, -originCm.y * k);
    if (kit && binHot) renderBin(ctx, kit, k, true);
    if (drawLive) {
      for (const o of overlays) renderOverlay(ctx, board, o, kit, k, targets);
      for (const r of rings) renderGhostRing(ctx, r, k);
    }
    ctx.restore();

    // Dirty rect in canvas pixels: the live bounds now and last time, or everything.
    const live = drawLive
      ? [
          ...overlays.map((o) => overlayBounds(board, o, kit)),
          ...rings.map((r) => ({ x: r.x - 1.2, y: r.y - 1.2, w: 2.4, h: 2.4 })),
        ].filter((r): r is Rect => r !== null)
      : [];
    const liveNow = live.length
      ? live.reduce((a, r) => {
          const x0 = Math.min(a.x, r.x);
          const y0 = Math.min(a.y, r.y);
          return { x: x0, y: y0, w: Math.max(a.x + a.w, r.x + r.w) - x0, h: Math.max(a.y + a.h, r.y + r.h) - y0 };
        })
      : null;
    if (full) this.dirty = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
    else {
      const rs = [liveNow, this.lastLive].filter((r): r is Rect => r !== null);
      if (!rs.length) this.dirty = null;
      else {
        const x0 = Math.min(...rs.map((r) => r.x));
        const y0 = Math.min(...rs.map((r) => r.y));
        const x1 = Math.max(...rs.map((r) => r.x + r.w));
        const y1 = Math.max(...rs.map((r) => r.y + r.h));
        const s = k * dpr;
        const px = Math.max(0, Math.floor((x0 - originCm.x) * s));
        const py = Math.max(0, Math.floor((y0 - originCm.y) * s));
        this.dirty = {
          x: px,
          y: py,
          w: Math.min(this.canvas.width, Math.ceil((x1 - originCm.x) * s)) - px,
          h: Math.min(this.canvas.height, Math.ceil((y1 - originCm.y) * s)) - py,
        };
      }
    }
    this.lastLive = liveNow;
    return true;
  }
}
