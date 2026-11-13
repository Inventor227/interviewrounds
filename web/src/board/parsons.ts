// The Parsons puzzle for the short coding round (and the no-microphone fallback): the lines of
// a reference solution, shuffled, with a distractor or two mixed in. The first line (the
// `def`) and the last (the `return`) stay locked in place; the candidate orders and indents
// the rest on the code panel (drag up and down, nudge sideways, like any code line), drops
// distractors on the bin, then checks: order and indent both count.

export interface ParsonsBlock {
  id: string;
  text: string;
  /** Shuffled blocks start flat: getting the indent right is part of the puzzle. */
  indent: number;
  locked: boolean;
  distractor: boolean;
}

/** A small seeded generator, so a round shuffles the same way every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shuffled blocks: the solution's first and last lines locked at the ends, the lines between
 * plus the distractors (ids d1, d2, ...) shuffled, never left in solution order.
 */
export function parsons(lines: readonly { id: string; text: string; indent: number }[], distractors: readonly string[], seed = 1): ParsonsBlock[] {
  if (lines.length < 2) return lines.map((l) => ({ ...l, locked: true, distractor: false }));
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  const middle: ParsonsBlock[] = [
    ...lines.slice(1, -1).map((l) => ({ id: l.id, text: l.text, indent: 0, locked: false, distractor: false })),
    ...distractors.map((text, i) => ({ id: `d${i + 1}`, text, indent: 0, locked: false, distractor: true })),
  ];
  const r = rng(seed);
  const order = middle.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // Never hand out the answer: if the real lines came out in solution order, swap the first
  // two of them (a lone middle line has only one order).
  // (Compared by text: two identical lines swapped still read as the answer.)
  const want = JSON.stringify(lines.slice(1, -1).map((l) => l.text));
  const realAt = order.flatMap((b, i) => (b.distractor ? [] : [i]));
  if (realAt.length > 1 && JSON.stringify(realAt.map((i) => order[i]!.text)) === want) {
    // Two blocks that read differently (swapping two identical lines would change nothing on screen).
    const a = realAt[0]!;
    const b = realAt.find((i) => order[i]!.text !== order[a]!.text) ?? realAt[1]!;
    [order[a], order[b]] = [order[b]!, order[a]!];
  }
  return [
    { id: first.id, text: first.text, indent: first.indent, locked: true, distractor: false },
    ...order,
    { id: last.id, text: last.text, indent: last.indent, locked: true, distractor: false },
  ];
}

/**
 * A line as checked: its id, or its id and indent (then the indent must match too), and
 * optionally its text (then lines that read the same are interchangeable: `else:` or `i += 1`
 * twice in a solution can go either way round).
 */
export type ParsonsLine = string | { id: string; indent: number; text?: string };

const lineIndent = (l: ParsonsLine) => (typeof l === 'string' ? null : l.indent);

function sameLine(o: ParsonsLine, w: ParsonsLine): boolean {
  if (typeof o !== 'string' && typeof w !== 'string' && o.text !== undefined && w.text !== undefined) return o.text.trim() === w.text.trim();
  return (typeof o === 'string' ? o : o.id) === (typeof w === 'string' ? w : w.id);
}

/**
 * Checks the candidate's lines (top to bottom) against the solution. With indents on both
 * sides (code lines as they are on the panel, and the reference solution), a line at the
 * wrong indent is wrong too; firstWrongIndex is the first line out of place or out of line.
 */
export function checkParsons(order: readonly ParsonsLine[], solution: readonly ParsonsLine[]): { correct: boolean; firstWrongIndex: number | null } {
  const n = Math.max(order.length, solution.length);
  for (let i = 0; i < n; i++) {
    const o = order[i];
    const w = solution[i];
    if (o === undefined || w === undefined || !sameLine(o, w)) return { correct: false, firstWrongIndex: i };
    const oi = lineIndent(o);
    const wi = lineIndent(w);
    if (oi !== null && wi !== null && oi !== wi) return { correct: false, firstWrongIndex: i };
  }
  return { correct: true, firstWrongIndex: null };
}

/** The panel's lines (or the solution's) as checkParsons takes them: id, indent and text, top to bottom. */
export function parsonsAnswer(lines: readonly { id: string; indent: number; text?: string }[]): { id: string; indent: number; text?: string }[] {
  return lines.map((l) => (l.text === undefined ? { id: l.id, indent: l.indent } : { id: l.id, indent: l.indent, text: l.text }));
}
