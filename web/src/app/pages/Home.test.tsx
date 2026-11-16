import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMe } from '../fake/server';
import { $, cleanup, click, renderApp, settle, stubNavigator, useFakeServer } from '../test-utils';

describe('Home', () => {
  afterEach(cleanup);

  it('home_shows_resume_when_resumable', async () => {
    useFakeServer({ scenario: 'resume' });
    const root = await renderApp('/');
    expect($(root, 'resume-banner')).not.toBeNull();
    await click($(root, 'resume'));
    expect(location.pathname).toBe('/resume/s_resume');
    expect($(root, 'page-resume')).not.toBeNull();
  });

  it('home_says_paused_for_a_paused_round_and_dropped_otherwise', async () => {
    const me = fakeMe('resume');
    me.resumable = { ...me.resumable!, paused: true };
    useFakeServer({ me });
    const root = await renderApp('/');
    expect($(root, 'resume-title')!.textContent).toBe('Your round is paused');
    cleanup();
    const dropped = fakeMe('resume');
    dropped.resumable = { ...dropped.resumable!, paused: false };
    useFakeServer({ me: dropped });
    const root2 = await renderApp('/');
    expect($(root2, 'resume-title')!.textContent).toMatch(/round dropped$/);
  });

  it('home_hides_resume_when_nothing_to_resume', async () => {
    useFakeServer({ scenario: '1' });
    const root = await renderApp('/');
    expect($(root, 'resume-banner')).toBeNull();
  });

  it('home_hides_resume_after_it_expires', async () => {
    const me = fakeMe('resume');
    me.resumable = { ...me.resumable!, expires_at: new Date(Date.now() - 1000).toISOString() };
    useFakeServer({ me });
    const root = await renderApp('/');
    expect($(root, 'resume-banner')).toBeNull();
  });

  it('home_button_goes_straight_to_the_preset_quick_round', async () => {
    useFakeServer({ scenario: '1' });
    const root = await renderApp('/');
    const cta = $(root, 'try-quick') as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/round/sde.system_design.short');
    await click(cta);
    expect($(root, 'page-start')?.dataset.round).toBe('sde.system_design.short');
  });

  it('home_shows_three_short_icon_steps_and_one_primary_button', async () => {
    useFakeServer({ scenario: 'first' });
    const root = await renderApp('/');
    const steps = $(root, 'how-it-works')!.querySelectorAll('li');
    expect(steps.length).toBe(3);
    steps.forEach((li) => expect(li.textContent!.length).toBeLessThan(80));
    expect(root.querySelectorAll('.btn-primary').length).toBe(1);
  });

  it('home_links_today_round_and_streak', async () => {
    useFakeServer({ scenario: '1' });
    const root = await renderApp('/');
    expect($(root, 'today-start')?.getAttribute('href')).toBe('/round/sde.system_design.short');
    expect($(root, 'streak')?.dataset.current).toBe('3');
  });

  it('home_tap_does_not_pull_the_user_back_after_they_left', async () => {
    useFakeServer({ scenario: '1' });
    let answer!: (s: MediaStream) => void;
    const track = { stop: vi.fn() };
    const restore = stubNavigator('mediaDevices', { getUserMedia: () => new Promise<MediaStream>((r) => (answer = r)) });
    try {
      const root = await renderApp('/');
      await click($(root, 'try-quick'));
      await click(root.querySelector('a[href="/history"]'));
      expect(location.pathname).toBe('/history');
      answer({ getTracks: () => [track] } as unknown as MediaStream);
      await settle();
      expect(location.pathname).toBe('/history');
      expect(track.stop).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('home_never_offers_sign_in', async () => {
    const me = fakeMe('1');
    me.sign_in_available = true;
    useFakeServer({ me });
    const root = await renderApp('/');
    expect($(root, 'sign-in')).toBeNull();
    expect(root.textContent).not.toMatch(/sign in/i);
  });

  it('home_shows_cap_instead_of_start_when_capped', async () => {
    useFakeServer({ scenario: 'capped' });
    const root = await renderApp('/');
    expect($(root, 'try-quick')).toBeNull();
    expect($(root, 'cap-notice')?.dataset.reason).toBe('guest_daily_limit');
  });

  it('home_still_offers_a_round_when_the_server_is_down', async () => {
    useFakeServer({ routes: { 'GET /api/me': () => new Response('', { status: 502 }) } });
    const root = await renderApp('/');
    expect($(root, 'try-quick')).not.toBeNull();
  });
});
