import { describe, expect, it } from 'vitest';
import { HANDS_LOST_LINE, HANDS_LOST_MS, HandsLostWatch } from './handsLost';

describe('hand tracking lost', () => {
  it('says_so_once_after_5_s_without_any_hand_and_again_only_after_they_came_back', () => {
    const w = new HandsLostWatch();
    expect(w.update(0, true)).toBe(false);
    expect(w.update(1000, false)).toBe(false);
    expect(w.update(1000 + HANDS_LOST_MS - 1, false)).toBe(false);
    expect(w.update(1000 + HANDS_LOST_MS, false)).toBe(true);
    expect(w.update(1000 + HANDS_LOST_MS + 5000, false)).toBe(false); // once per loss
    expect(w.update(20_000, true)).toBe(false);
    expect(w.update(21_000, false)).toBe(false);
    expect(w.update(21_000 + HANDS_LOST_MS, false)).toBe(true);
  });

  it('a_short_dropout_or_one_hand_still_in_view_shows_nothing', () => {
    const w = new HandsLostWatch();
    for (let t = 0; t < 60_000; t += 1000) expect(w.update(t, t % 4000 !== 0)).toBe(false); // gaps of one second
    w.update(60_000, false);
    w.reset(); // the headset came off: frames stopped
    expect(w.update(120_000, false)).toBe(false);
    expect(HANDS_LOST_LINE.length).toBeLessThanOrEqual(48);
  });
});
