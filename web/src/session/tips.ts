// Tips after the first gesture: one short line at the moment it is useful, each shown once per device. The first
// card brings the naming line, the first faint card the line about keeping it, two cards without a line between them
// the line about linking. One at a time, with a pause between them, and never over another hint. Pure logic: the
// room supplies the board, the clock and the hint line.

import { ONBOARDING_KITS } from './onboarding';

export type TipId = 'name' | 'keep' | 'link';

export const TIP_COPY: Record<TipId, string> = {
  name: 'Say "call that the cache" to name a card',
  keep: 'Pinch a faint card to keep it',
  link: 'Draw a line between two cards to link them',
};

/** How long a tip stays up, and the quiet time after it before the next. */
export const TIP_SHOW_MS = 7000;
export const TIP_GAP_MS = 12_000;

const STORE_KEY = 'ir_tips_seen';
const ORDER: readonly TipId[] = ['name', 'keep', 'link'];

/** What the tips look at: the cards on the sheet (no ink, no cards of the interviewer), lines and faint cards. */
export interface TipBoard {
  cards: number;
  edges: number;
  ghosts: number;
}

/** Whether this round gives tips: a sheet where boxes are cards, in the headset. */
export function givesTips(opts: { kit: string | null; preview: boolean }): boolean {
  return !opts.preview && !!opts.kit && ONBOARDING_KITS.includes(opts.kit);
}

export class Tips {
  private readonly seen: Set<TipId>;
  private quietUntil = 0;

  constructor(
    seen: Iterable<TipId> = [],
    private readonly save: (seen: TipId[]) => void = () => undefined,
  ) {
    this.seen = new Set(seen);
  }

  /** The tip to show now, or null. `busy`: another hint is up, or the first-round step is still on the sheet. */
  next(nowMs: number, board: TipBoard, busy: boolean): { id: TipId; line: string } | null {
    if (busy || nowMs < this.quietUntil) return null;
    const due: Record<TipId, boolean> = {
      name: board.cards >= 1,
      keep: board.ghosts >= 1,
      link: board.cards >= 2 && board.edges === 0,
    };
    const id = ORDER.find((t) => due[t] && !this.seen.has(t));
    if (!id) return null;
    this.seen.add(id);
    this.quietUntil = nowMs + TIP_SHOW_MS + TIP_GAP_MS;
    this.save([...this.seen]);
    return { id, line: TIP_COPY[id] };
  }
}

/** The tips this device has shown (kept in the browser; a blocked or empty store means none). */
export function loadSeenTips(): TipId[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((t): t is TipId => ORDER.includes(t as TipId)) : [];
  } catch {
    return [];
  }
}

export function saveSeenTips(seen: TipId[]): void {
  try {
    globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(seen));
  } catch {
    // a blocked store: the tips show again next time
  }
}
