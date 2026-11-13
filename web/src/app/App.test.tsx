import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

function renderAt(path: string): HTMLElement {
  history.replaceState(null, '', path);
  const root = document.createElement('div');
  document.body.append(root);
  act(() => render(<App />, root));
  return root;
}

describe('App shell', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each([
    ['/', 'page-home'],
    ['/start/sde', 'page-pick-round'],
    ['/round/sde.system_design.short', 'page-start'],
    ['/meeting/new', 'page-meeting'],
    ['/session/s1', 'page-session'],
    ['/report/s1', 'page-report'],
    ['/history', 'page-history'],
    ['/settings', 'page-settings'],
    ['/pricing', 'page-pricing'],
    ['/nope', 'page-not-found'],
  ])('routes %s to its placeholder', (path, test) => {
    const root = renderAt(path);
    expect(root.querySelector(`[data-test="${test}"]`)).not.toBeNull();
  });

  it('passes_route_params', () => {
    const root = renderAt('/round/sde.coding.short');
    expect(root.textContent).toContain('sde.coding.short');
  });
});
