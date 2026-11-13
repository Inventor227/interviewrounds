import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsOnboarding, ONBOARD_TIMEOUT_MS, Onboarding } from './onboarding';

function host(cards: { id: string }[] = []) {
  const board = new Set<() => void>();
  const skip = new Set<() => void>();
  const shown: string[] = [];
  return {
    cards,
    shown,
    listeners: () => board.size + skip.size,
    changed: () => board.forEach((cb) => cb()),
    skip: () => skip.forEach((cb) => cb()),
    host: {
      cards: () => cards,
      onBoard: (cb: () => void) => (board.add(cb), () => board.delete(cb)),
      show: (on: boolean, why?: string) => void shown.push(on ? 'on' : `off:${why ?? ''}`),
      onSkip: (cb: () => void) => (skip.add(cb), () => skip.delete(cb)),
    },
  };
}

describe('onboarding by doing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the_step_ends_at_the_drawn_box_and_nothing_follows_it', async () => {
    const h = host([{ id: 'old' }]);
    const o = new Onboarding(h.host);
    let result: string | null = null;
    void o.run().then((r) => (result = r));
    expect(h.shown).toEqual(['on']);
    h.changed(); // an ink stroke, a hover: no new card yet
    await vi.advanceTimersByTimeAsync(5000);
    expect(result).toBeNull();
    h.cards.push({ id: 'c1' });
    h.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe('done');
    // No second step ("Say its name" is gone): everything is down and nothing listens any more.
    expect(h.shown).toEqual(['on', 'off:done']);
    expect(o.showing).toBe(false);
    expect(h.listeners()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.shown).toEqual(['on', 'off:done']);
  });

  it('onboarding_never_blocks_the_round_it_ends_by_itself_after_20_s', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    let result: string | null = null;
    void o.run().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(ONBOARD_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('skipped');
    expect(h.shown).toEqual(['on', 'off:timeout']);
    expect(ONBOARD_TIMEOUT_MS).toBe(20_000);
  });

  it('skip_ends_it_with_one_pinch', async () => {
    const h = host();
    const r = new Onboarding(h.host).run();
    h.skip();
    await expect(r).resolves.toBe('skipped');
    expect(h.shown).toEqual(['on', 'off:skipped']);
    expect(h.listeners()).toBe(0);
  });

  it('leaving_and_coming_back_shows_the_line_and_skip_again', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    const r = o.run();
    expect(o.run()).toBe(r); // the second Enter: the same step
    expect(h.shown).toEqual(['on', 'on']); // shown again (the desk prompt had taken the card)
    h.skip();
    await r;
    expect(o.run()).toBe(r);
    expect(h.shown).toEqual(['on', 'on', 'off:skipped']); // over: nothing comes back
  });

  it('the_clock_waits_while_the_user_is_out_of_the_headset_view', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    let result: string | null = null;
    void o.run().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(10_000);
    o.suspend(); // the headset session ended
    await vi.advanceTimersByTimeAsync(120_000);
    expect(result).toBeNull(); // no round starts into an empty room
    void o.run(); // back: the line again, and a fresh 20 s
    await vi.advanceTimersByTimeAsync(ONBOARD_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('skipped');
  });

  it('closing_the_room_settles_a_waiting_run', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    const r = o.run();
    o.dispose();
    await expect(r).resolves.toBe('none');
    expect(h.listeners()).toBe(0);
  });

  it('onboarding_skipped_when_done', () => {
    expect(needsOnboarding({ kit: 'hld', done: false, preview: false })).toBe(true);
    expect(needsOnboarding({ kit: 'hld', done: true, preview: false })).toBe(false); // me.onboarding_done
    expect(needsOnboarding({ kit: null, done: false, preview: false })).toBe(false); // no board, no onboarding
    expect(needsOnboarding({ kit: 'coding', done: false, preview: false })).toBe(false);
    expect(needsOnboarding({ kit: 'hld', done: false, preview: true })).toBe(false);
    expect(needsOnboarding({ kit: 'hld', done: undefined, preview: false })).toBe(false);
  });
});
