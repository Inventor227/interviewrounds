import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../shared/types';
import { createRoundClock, itemCentre } from './roundClock';

describe('round clock', () => {
  it('runs_on_between_snapshots_while_live_and_stands_still_otherwise', () => {
    let t = 1000;
    const c = createRoundClock(() => t);
    expect(c.now_s()).toBe(0);
    c.sync(12, 'live');
    t += 2500;
    expect(c.now_s()).toBe(14.5);
    c.sync(15, 'paused');
    t += 60_000;
    expect(c.now_s()).toBe(15); // pauses do not count
    c.sync(15, 'live');
    t += 1000;
    expect(c.now_s()).toBe(16);
    c.sync(480, 'scoring');
    t += 5000;
    expect(c.now_s()).toBe(480);
  });

  it('a_card_is_pointed_at_in_its_centre', () => {
    const card = { kind: 'component', id: 'n1', type: 'service', label: null, x: 10, y: 4, w: 12, h: 6 } as BoardItem;
    expect(itemCentre(card)).toEqual({ x: 16, y: 7 });
    expect(itemCentre({ kind: 'sticky', id: 's1', x: 3, y: 5 } as unknown as BoardItem)).toEqual({ x: 3, y: 5 });
    expect(itemCentre({ kind: 'ink', id: 'i1', points: [] } as unknown as BoardItem)).toBeNull();
    expect(itemCentre(undefined)).toBeNull();
  });
});
