// The Parsons puzzle for the short coding round (and the no-microphone fallback): the lines of
// a reference solution, shuffled, with a distractor or two mixed in. The first line (the
// `def`) and the last (the `return`) stay locked in place; the candidate orders and indents
// the rest on the code panel, drops distractors on the bin, then checks.

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
  // Never hand out the answer: if the shuffle left the real lines in order, rotate once.
  const real = order.filter((b) => !b.distractor).map((b) => b.id);
  if (order.length > 1 && real.join() === lines.slice(1, -1).map((l) => l.id).join()) order.push(order.shift()!);
  return [
    { id: first.id, text: first.text, indent: first.indent, locked: true, distractor: false },
    ...order,
    { id: last.id, text: last.text, indent: last.indent, locked: true, distractor: false },
  ];
}

/** Checks the candidate's order (line ids, top to bottom) against the solution. */
export function checkParsons(order: readonly string[], solution: readonly string[]): { correct: boolean; firstWrongIndex: number | null } {
  const n = Math.max(order.length, solution.length);
  for (let i = 0; i < n; i++) {
    if (order[i] !== solution[i]) return { correct: false, firstWrongIndex: i };
  }
  return { correct: true, firstWrongIndex: null };
}
