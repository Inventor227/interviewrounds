import { describe, afterEach, expect, it } from 'vitest';
import { LIMIT_REASONS } from '../../shared/types';
import { $, cleanup, renderNode } from '../test-utils';
import { CapNotice } from './CapNotice';
import { capFromError } from './data';
import { resetPhrase } from './format';
import { ApiError } from '../../net/api';

describe('CapNotice', () => {
  afterEach(cleanup);
  const now = new Date(2026, 10, 13, 15, 0, 0);
  const resets = new Date(2026, 10, 14, 0, 0, 0).toISOString();

  it.each(LIMIT_REASONS.filter((r) => r !== 'free_rounds_used'))('cap_notice_shows_reset_time (%s)', async (reason) => {
    const root = await renderNode(<CapNotice reason={reason} resetsAt={resets} now={now} />);
    expect($(root, 'cap-notice')?.dataset.reason).toBe(reason);
    const t = root.querySelector('time');
    expect(t?.getAttribute('datetime')).toBe(resets);
    expect(t?.textContent).toBe(resetPhrase(resets, now));
  });

  it('reset_time_is_in_local_time', () => {
    const local = new Date(2026, 10, 14, 0, 30);
    const text = resetPhrase(local.toISOString(), now);
    expect(text).toContain(new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(local));
    // Same day next week reads differently from tomorrow: the phrase depends on the local date.
    const later = new Date(2026, 10, 20, 0, 30);
    expect(resetPhrase(later.toISOString(), now)).not.toBe(text);
  });

  it('free_rounds_used_points_to_plans', async () => {
    const root = await renderNode(<CapNotice reason="free_rounds_used" resetsAt={null} />);
    expect($(root, 'cap-plans')?.getAttribute('href')).toBe('/pricing');
    expect(root.querySelector('time')).toBeNull();
  });

  it('reads_cap_errors_from_the_server', () => {
    const err = new ApiError(429, 'guest_daily_limit', 'Limit', { code: 'guest_daily_limit', message: 'Limit', resets_at: resets });
    expect(capFromError(err)).toEqual({ reason: 'guest_daily_limit', resetsAt: resets });
    expect(capFromError(new ApiError(500, 'oops', 'x'))).toBeNull();
  });
});
