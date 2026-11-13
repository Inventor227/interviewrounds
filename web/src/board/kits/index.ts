// The kit for a round: the board's round type picks it (board.round.type).
import type { Board, BoardKit } from '../../shared/types';
import { HLD_KIT, type Kit } from '../kits';
import { createCodingKit } from './coding';
import { LLD_KIT } from './lld';
import { MEETING_KIT } from './meeting';
import { PM_KIT } from './pm';

export { createCodingKit } from './coding';
export { LLD_KIT } from './lld';
export { MEETING_KIT } from './meeting';
export { PM_KIT } from './pm';

/** The kit for a board kit name; coding takes the Parsons puzzle's locked lines, if any. */
export function kitForRound(kit: BoardKit, opts: { locked?: readonly string[] } = {}): Kit {
  switch (kit) {
    case 'hld':
      return HLD_KIT;
    case 'lld':
      return LLD_KIT;
    case 'pm':
      return PM_KIT;
    case 'meeting':
      return MEETING_KIT;
    case 'coding':
      return createCodingKit(opts);
  }
}

export function kitForBoard(board: Board, opts: { locked?: readonly string[] } = {}): Kit {
  return kitForRound(board.round.type, opts);
}
