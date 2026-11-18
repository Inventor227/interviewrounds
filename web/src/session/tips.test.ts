import { describe, expect, it } from 'vitest';
import { givesTips, TIP_COPY, TIP_GAP_MS, TIP_SHOW_MS, Tips, type TipId } from './tips';

const empty = { cards: 0, edges: 0, ghosts: 0 };

describe('tips after the first gesture', () => {
  it('nothing_is_said_on_an_empty_sheet', () => {
    expect(new Tips().next(0, empty, false)).toBeNull();
  });

  it('the_first_card_brings_the_naming_line_once', () => {
    const tips = new Tips();
    expect(tips.next(1000, { ...empty, cards: 1 }, false)).toEqual({ id: 'name', line: TIP_COPY.name });
    expect(tips.next(1000 + TIP_SHOW_MS + TIP_GAP_MS, { ...empty, cards: 1 }, false)).toBeNull();
  });

  it('one_tip_at_a_time_with_a_pause_between', () => {
    const tips = new Tips();
    const board = { cards: 2, edges: 0, ghosts: 1 };
    expect(tips.next(0, board, false)?.id).toBe('name');
    expect(tips.next(TIP_SHOW_MS + TIP_GAP_MS - 1, board, false)).toBeNull();
    expect(tips.next(TIP_SHOW_MS + TIP_GAP_MS, board, false)?.id).toBe('keep');
    expect(tips.next(2 * (TIP_SHOW_MS + TIP_GAP_MS), board, false)?.id).toBe('link');
    expect(tips.next(9 * (TIP_SHOW_MS + TIP_GAP_MS), board, false)).toBeNull();
  });

  it('never_over_another_hint_or_the_first_round_step', () => {
    const tips = new Tips();
    expect(tips.next(0, { ...empty, cards: 1 }, true)).toBeNull();
    expect(tips.next(1, { ...empty, cards: 1 }, false)?.id).toBe('name');
  });

  it('cards_already_linked_need_no_linking_line', () => {
    const tips = new Tips(['name']);
    expect(tips.next(0, { cards: 2, edges: 1, ghosts: 0 }, false)).toBeNull();
  });

  it('a_tip_this_device_has_seen_is_not_shown_again_and_new_ones_are_saved', () => {
    const saved: TipId[][] = [];
    const tips = new Tips(['name', 'link'], (s) => saved.push(s));
    expect(tips.next(0, { cards: 2, edges: 0, ghosts: 0 }, false)).toBeNull();
    expect(tips.next(0, { cards: 2, edges: 0, ghosts: 1 }, false)?.id).toBe('keep');
    expect(saved).toEqual([['name', 'link', 'keep']]);
  });

  it('only_headset_rounds_with_a_card_sheet_give_tips', () => {
    expect(givesTips({ kit: 'hld', preview: false })).toBe(true);
    expect(givesTips({ kit: 'hld', preview: true })).toBe(false);
    expect(givesTips({ kit: 'coding', preview: false })).toBe(false);
    expect(givesTips({ kit: null, preview: false })).toBe(false);
  });

  it('every_line_is_short_enough_for_the_hint', () => {
    for (const line of Object.values(TIP_COPY)) expect(line.length).toBeLessThanOrEqual(48);
  });
});
