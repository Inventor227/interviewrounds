// Suggestions never stack. The server places a new suggested item clear of the board and of the suggestions
// still pending; this is the page's own guard for the same rule (a suggestion list from an older server, or one
// that changed on the way): a new item that would sit on another pending suggestion moves to the first free
// spot. A pinch then always takes the suggestion that shows.
import type { Board, GhostOp } from '../shared/types';
import { itemRect, type Rect } from './model';

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The first spot on a grid of the item's size (2 cm apart) that clears every rect by 1 cm, top-left first. */
function freeSpot(board: Board, taken: Rect[], w: number, h: number): [number, number] | null {
  const sw = Math.ceil(w);
  const sh = Math.ceil(h);
  for (let y = 2; y + sh < board.size.h; y += sh + 2) {
    for (let x = 2; x + sw < board.size.w; x += sw + 2) {
      const r = { x: x - 1, y: y - 1, w: sw + 2, h: sh + 2 };
      if (!taken.some((t) => overlap(r, t))) return [x, y];
    }
  }
  return null;
}

/** PM sheet: a sticky's lane column (12 cm lanes from the left, a 7 cm sticky centred), first row under the headers. */
const PM_LANES = ['user', 'pain', 'idea', 'metric'] as const;
const LANE_W = 12;
const STICKY = 7;

/** The first free spot down a PM sticky's own lane, 1 cm apart. */
function laneSpot(board: Board, taken: Rect[], lane: string): [number, number] | null {
  const i = PM_LANES.indexOf(lane as (typeof PM_LANES)[number]);
  if (i < 0) return null;
  const x = i * LANE_W + (LANE_W - STICKY) / 2;
  for (let y = 3; y + STICKY <= board.size.h; y += STICKY + 1) {
    if (!taken.some((t) => overlap({ x: x - 0.5, y: y - 0.5, w: STICKY + 1, h: STICKY + 1 }, t))) return [x, y];
  }
  return null;
}

/** The ghost list with every new item off the pending suggestions before it (and off the board's items when it moves). */
export function destack(board: Board, ghosts: GhostOp[]): GhostOp[] {
  const items = board.items.map(itemRect);
  const placed: Rect[] = [];
  return ghosts.map((g) => {
    if (g.op !== 'item.create' || g.args.kind === 'ink') return g;
    const r = itemRect(g.args);
    // Off the other pending suggestions and off the board's items (one just accepted among them).
    if (!placed.some((p) => overlap(r, p)) && !items.some((p) => overlap(r, p))) {
      placed.push(r);
      return g;
    }
    const taken = [...items, ...placed];
    // A PM sticky stays in its own lane's column.
    const lane = board.round.type === 'pm' && g.args.kind === 'sticky' ? g.args.lane : null;
    const spot = (lane ? laneSpot(board, taken, lane) : null) ?? freeSpot(board, taken, r.w, r.h);
    if (!spot) {
      placed.push(r);
      return g;
    }
    placed.push({ ...r, x: spot[0], y: spot[1] });
    return { ...g, args: { ...g.args, x: spot[0], y: spot[1] } } as GhostOp;
  });
}
