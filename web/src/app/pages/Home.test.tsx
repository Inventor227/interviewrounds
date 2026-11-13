import { afterEach, describe, expect, it } from 'vitest';
import { fakeMe } from '../fake/server';
import { $, cleanup, click, renderApp, useFakeServer } from '../test-utils';

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
    expect($(root, 'sign-in')).not.toBeNull();
    await click(cta);
    expect($(root, 'page-start')?.dataset.round).toBe('sde.system_design.short');
  });

  it('home_shows_no_intro_on_first_visit_only_a_how_it_works_link', async () => {
    useFakeServer({ scenario: 'first' });
    const root = await renderApp('/');
    expect($(root, 'how-cards')).toBeNull();
    await click($(root, 'how-toggle'));
    expect($(root, 'how-cards')).not.toBeNull();
  });

  it('home_links_today_round_and_streak', async () => {
    useFakeServer({ scenario: '1' });
    const root = await renderApp('/');
    expect($(root, 'today-start')?.getAttribute('href')).toBe('/round/sde.system_design.short');
    expect($(root, 'streak')?.dataset.current).toBe('3');
  });

  it('home_hides_sign_in_when_unavailable', async () => {
    const me = fakeMe('1');
    me.sign_in_available = false;
    useFakeServer({ me });
    const root = await renderApp('/');
    expect($(root, 'sign-in')).toBeNull();
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
