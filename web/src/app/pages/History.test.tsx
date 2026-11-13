import { afterEach, describe, expect, it } from 'vitest';
import { $, $$, cleanup, click, renderApp, useFakeServer } from '../test-utils';

describe('History', () => {
  afterEach(cleanup);

  it('history_lists_reports_and_filters_by_role', async () => {
    const server = useFakeServer();
    const root = await renderApp('/history');
    expect($$(root, 'history-item')).toHaveLength(5);
    expect($(root, 'skill-chart')).not.toBeNull();
    await click(root.querySelector('[data-test="role-pm"]'));
    expect(server.calls.some((c) => c.path === '/api/me/history?role=pm')).toBe(true);
    expect($$(root, 'history-item')).toHaveLength(1);
    expect($$(root, 'history-item')[0]!.getAttribute('href')).toBe('/report/h3');
  });

  it('history_empty_state_offers_a_round', async () => {
    useFakeServer({ scenario: 'empty' });
    const root = await renderApp('/history');
    expect($(root, 'history-empty')).not.toBeNull();
  });
});
