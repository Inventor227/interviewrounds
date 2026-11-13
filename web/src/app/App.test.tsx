import { afterEach, describe, expect, it } from 'vitest';
import { isQuestBrowser } from './App';
import { $, cleanup, renderApp, useFakeServer } from './test-utils';

describe('App shell', () => {
  afterEach(cleanup);

  it.each([
    ['/', 'page-home'],
    ['/start', 'page-pick-role'],
    ['/start/sde', 'page-pick-round'],
    ['/round/sde.system_design.short', 'page-start'],
    ['/meeting/new', 'page-meeting'],
    ['/session/s1', 'page-session'],
    ['/report/s1', 'page-report'],
    ['/history', 'page-history'],
    ['/settings', 'page-settings'],
    ['/pricing', 'page-not-found'],
    ['/not-supported', 'page-not-supported'],
    ['/nope', 'page-not-found'],
  ])('routes %s to its page', async (path, test) => {
    useFakeServer();
    const root = await renderApp(path);
    expect($(root, test)).not.toBeNull();
  });

  it('nav_has_no_plans_link', async () => {
    useFakeServer();
    const root = await renderApp('/');
    const nav = root.querySelector('nav.nav')!;
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['History', 'Settings']);
    expect(root.querySelector('a[href="/pricing"]')).toBeNull();
  });

  it('passes_route_params', async () => {
    useFakeServer();
    const root = await renderApp('/round/sde.coding.short');
    expect($(root, 'page-start')?.dataset.round).toBe('sde.coding.short');
  });

  it('every_page_has_one_h1', async () => {
    useFakeServer();
    for (const path of ['/', '/start', '/start/pm', '/round/sde.coding.short', '/meeting/new', '/report/demo', '/history', '/settings']) {
      const root = await renderApp(path);
      expect(root.querySelectorAll('h1')).toHaveLength(1);
      cleanup();
      useFakeServer();
    }
  });

  it('quest_browser_gets_the_dim_palette', () => {
    const quest = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/40.0 Chrome/138 Safari/537.36';
    expect(isQuestBrowser(quest, '')).toBe(true);
    expect(isQuestBrowser('Mozilla/5.0 (Macintosh) Chrome/138 Safari/537.36', '')).toBe(false);
    expect(isQuestBrowser('Mozilla/5.0 (Macintosh)', '?device=quest')).toBe(true);
  });
});
