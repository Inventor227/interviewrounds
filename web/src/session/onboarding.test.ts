import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsOnboarding, ONBOARD_TIMEOUT_MS, Onboarding, watchPresence } from './onboarding';

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

  function presence() {
    const vis = new Set<(v: 'visible' | 'visible-blurred' | 'hidden') => void>();
    const ends = new Set<() => void>();
    const pageCbs = new Set<() => void>();
    const page = {
      visibilityState: 'visible',
      addEventListener: (_t: 'visibilitychange', cb: () => void) => void pageCbs.add(cb),
      removeEventListener: (_t: 'visibilitychange', cb: () => void) => void pageCbs.delete(cb),
    };
    let now: 'visible' | 'visible-blurred' | 'hidden' = 'visible';
    return {
      setNow: (v: 'visible' | 'visible-blurred' | 'hidden') => (now = v),
      src: { xrNow: () => now, onXrVisibility: (cb: (v: 'visible' | 'visible-blurred' | 'hidden') => void) => (vis.add(cb), () => vis.delete(cb)), onSessionEnd: (cb: () => void) => (ends.add(cb), () => ends.delete(cb)), page },
      xr: (v: 'visible' | 'visible-blurred' | 'hidden') => vis.forEach((cb) => cb(v)),
      end: () => ends.forEach((cb) => cb()),
      page: (v: string) => {
        page.visibilityState = v;
        pageCbs.forEach((cb) => cb());
      },
      listeners: () => vis.size + ends.size + pageCbs.size,
    };
  }

  const AWAY: [string, (p: ReturnType<typeof presence>) => void, (p: ReturnType<typeof presence>) => void][] = [
    ['headset_off', (p) => p.xr('hidden'), (p) => p.xr('visible')],
    ['system_menu', (p) => p.xr('visible-blurred'), (p) => p.xr('visible')],
    ['page_hidden', (p) => p.page('hidden'), (p) => p.page('visible')],
  ];
  for (const [name, leave, back] of AWAY) {
    it(`the_auto_start_never_fires_while_the_user_is_not_in_the_room_${name}`, async () => {
      const h = host();
      const o = new Onboarding(h.host);
      const p = presence();
      const off = watchPresence(o, p.src).dispose;
      let result: string | null = null;
      void o.run().then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(15_000);
      leave(p);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(result).toBeNull(); // nobody is greeted in an empty room
      back(p);
      expect(h.shown).toEqual(['on', 'on']); // the line and Skip again
      await vi.advanceTimersByTimeAsync(ONBOARD_TIMEOUT_MS - 1); // and a fresh 20 s, not the 5 s that were left
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBe('skipped');
      off();
      expect(p.listeners()).toBe(0);
    });
  }

  it('away_twice_over_needs_both_back', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    const p = presence();
    watchPresence(o, p.src);
    let result: string | null = null;
    void o.run().then((r) => (result = r));
    p.xr('hidden');
    p.page('hidden');
    p.page('visible'); // the page is back, the headset is still off
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result).toBeNull();
    p.xr('visible');
    await vi.advanceTimersByTimeAsync(ONBOARD_TIMEOUT_MS);
    expect(result).toBe('skipped');
  });

  it('after_a_session_end_the_page_coming_back_into_view_starts_nothing_until_the_next_enter', async () => {
    const h = host();
    const o = new Onboarding(h.host);
    const p = presence();
    const w = watchPresence(o, p.src);
    let result: string | null = null;
    void o.run().then((r) => (result = r));
    p.end(); // the system ended the headset session; the user is on the 2D page
    p.page('hidden');
    p.page('visible'); // they look at the page again: still not in the room
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(result).toBeNull();
    expect(h.shown).toEqual(['on']);
    // The page's way back: a new Enter, then the same step with a fresh 20 s.
    w.entered();
    void o.run();
    await vi.advanceTimersByTimeAsync(ONBOARD_TIMEOUT_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('skipped');
  });

  it('the_first_clock_waits_for_a_menu_or_a_hidden_page_that_is_already_up', async () => {
    for (const already of ['menu', 'page'] as const) {
      const h = host();
      const o = new Onboarding(h.host);
      const p = presence();
      if (already === 'menu') p.setNow('visible-blurred');
      else p.page('hidden');
      watchPresence(o, p.src); // the watch starts with the menu up (or the page hidden)
      let result: string | null = null;
      void o.run().then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(result, already).toBeNull(); // no clock ran
      if (already === 'menu') p.xr('visible');
      else p.page('visible');
      await vi.advanceTimersByTimeAsync(ONBOARD_TIMEOUT_MS - 1);
      expect(result, already).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(result, already).toBe('skipped');
    }
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
