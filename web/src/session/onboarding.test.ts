import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAME_STEP_MS, needsOnboarding, Onboarding, type OnboardStep } from './onboarding';

function host(cards: { id: string; labelled: boolean }[] = []) {
  const board = new Set<() => void>();
  const skip = new Set<() => void>();
  const shown: (OnboardStep | null)[] = [];
  return {
    cards,
    shown,
    listeners: () => board.size + skip.size,
    changed: () => board.forEach((cb) => cb()),
    skip: () => skip.forEach((cb) => cb()),
    host: {
      cards: () => cards,
      onBoard: (cb: () => void) => (board.add(cb), () => board.delete(cb)),
      show: (s: OnboardStep | null) => void shown.push(s),
      onSkip: (cb: () => void) => (skip.add(cb), () => skip.delete(cb)),
    },
  };
}

describe('onboarding by doing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the_box_step_completes_only_when_the_user_makes_a_box', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    let result: string | null = null;
    void o.run().then((r) => (result = r));
    expect(h.shown).toEqual(['box']);
    h.changed(); // an ink stroke, a hover: no card yet
    await vi.advanceTimersByTimeAsync(60_000); // no time pressure
    expect(result).toBeNull();
    expect(o.showing).toBe('box');
    h.cards.push({ id: 'c1', labelled: false });
    h.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe('done');
    // Then "Say its name", until the first label.
    expect(h.shown).toEqual(['box', 'name']);
    h.cards[0]!.labelled = true;
    h.changed();
    expect(h.shown).toEqual(['box', 'name', null]);
    expect(h.listeners()).toBe(0);
  });

  it('say_its_name_goes_away_after_8_s_without_a_label', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    void o.run();
    h.cards.push({ id: 'c1', labelled: false });
    h.changed();
    await vi.advanceTimersByTimeAsync(NAME_STEP_MS - 1);
    expect(o.showing).toBe('name');
    await vi.advanceTimersByTimeAsync(1);
    expect(o.showing).toBeNull();
    expect(h.shown.at(-1)).toBeNull();
  });

  it('skip_ends_it_with_one_pinch', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    const r = o.run();
    h.skip();
    await expect(r).resolves.toBe('skipped');
    expect(h.shown).toEqual(['box', null]);
    expect(h.listeners()).toBe(0);
    // Skipping the name line after the box changes nothing about the result.
    const h2 = host();
    const o2 = new Onboarding(h2.host);
    const r2 = o2.run();
    h2.cards.push({ id: 'c1', labelled: false });
    h2.changed();
    h2.skip();
    await expect(r2).resolves.toBe('done');
    expect(h2.shown).toEqual(['box', 'name', null]);
  });

  it('cards_that_were_already_there_do_not_count_and_a_box_made_with_a_name_skips_the_name_line', async () => {
    const h = host([{ id: 'old', labelled: true }]);
    const o = new Onboarding(h.host);
    const r = o.run();
    h.changed();
    expect(o.showing).toBe('box');
    h.cards.push({ id: 'c1', labelled: true }); // pulled from the tray: it has its name
    h.changed();
    await expect(r).resolves.toBe('done');
    expect(h.shown).toEqual(['box', null]);
    expect(o.run()).toBe(r); // asked again (a second Enter): the same answer, nothing shown twice
  });

  it('onboarding_skipped_when_done', () => {
    // Only a first round with a sheet where boxes are cards, in the headset.
    expect(needsOnboarding({ kit: 'hld', done: false, preview: false })).toBe(true);
    expect(needsOnboarding({ kit: 'hld', done: true, preview: false })).toBe(false); // me.onboarding_done
    expect(needsOnboarding({ kit: null, done: false, preview: false })).toBe(false); // no board, no onboarding
    expect(needsOnboarding({ kit: 'coding', done: false, preview: false })).toBe(false);
    expect(needsOnboarding({ kit: 'hld', done: false, preview: true })).toBe(false);
    expect(needsOnboarding({ kit: 'hld', done: undefined, preview: false })).toBe(false); // unknown: never in the way
  });
});
