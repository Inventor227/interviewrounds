// Round time as the server counts it (no pauses), carried forward locally between the server's
// snapshots, and where a board item is in the room (for a panelist pointing at it).

import type { BoardItem } from '../shared/types';

export interface RoundClock {
  /** A `round.state` snapshot: the server's elapsed seconds and whether the round is running. */
  sync(elapsed_s: number, status: string): void;
  /** Seconds since the round started, without pauses. */
  now_s(): number;
}

export function createRoundClock(now: () => number = () => performance.now()): RoundClock {
  let elapsed = 0;
  let at = 0;
  let running = false;
  return {
    sync(elapsed_s, status) {
      elapsed = elapsed_s;
      at = now();
      running = status === 'live';
    },
    now_s: () => elapsed + (running ? Math.max(0, now() - at) / 1000 : 0),
  };
}

/** The centre of a board item in board cm, or null for items without a place of their own (ink). */
export function itemCentre(item: BoardItem | undefined): { x: number; y: number } | null {
  if (!item || !('x' in item) || typeof item.x !== 'number' || typeof item.y !== 'number') return null;
  const w = 'w' in item && typeof item.w === 'number' ? item.w : 0;
  const h = 'h' in item && typeof item.h === 'number' ? item.h : 0;
  return { x: item.x + w / 2, y: item.y + h / 2 };
}
