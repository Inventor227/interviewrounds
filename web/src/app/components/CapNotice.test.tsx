import { describe, afterEach, expect, it } from 'vitest';
import { LIMIT_REASONS, type LimitReason, type Me } from '../../shared/types';
import { $, cleanup, renderNode } from '../test-utils';
import { CapNotice } from './CapNotice';
import { capFromError, capFromMe } from './data';
import { resetPhrase } from './format';
import { ApiError } from '../../net/api';

describe('CapNotice', () => {
  afterEach(cleanup);
  const now = new Date(2026, 10, 13, 15, 0, 0);
  const resets = new Date(2026, 10, 14, 0, 0, 0).toISOString();

  const NO_RESET: readonly LimitReason[] = ['free_rounds_used', 'guest_full_used', 'judge_budget_reached'];

  it.each(LIMIT_REASONS.filter((r) => !NO_RESET.includes(r)))('cap_notice_shows_reset_time (%s)', async (reason) => {
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

  it('limits_that_never_reset_promise_no_time', async () => {
    const full = await renderNode(<CapNotice reason="guest_full_used" resetsAt={resets} now={now} />);
    expect(full.querySelector('.cap-body')?.textContent).toBe('Quick rounds are still open.');
    expect(full.querySelector('time')).toBeNull();
    cleanup();
    const budget = await renderNode(<CapNotice reason="judge_budget_reached" resetsAt={resets} now={now} />);
    expect(budget.querySelector('.cap-body')?.textContent).toBe('Guest rounds are paused for now. Reports and history still work.');
    expect(budget.querySelector('time')).toBeNull();
  });

  it('free_rounds_used_offers_no_plans', async () => {
    const root = await renderNode(<CapNotice reason="free_rounds_used" resetsAt={null} />);
    expect($(root, 'cap-plans')).toBeNull();
    expect(root.querySelector('a[href="/pricing"]')).toBeNull();
    expect(root.textContent).not.toMatch(/plan/i);
    expect(root.querySelector('time')).toBeNull();
  });

  it('guest_limit_without_a_reset_says_the_round_is_used', async () => {
    const root = await renderNode(<CapNotice reason="guest_daily_limit" resetsAt={null} now={now} />);
    expect(root.querySelector('.cap-title')?.textContent).toBe('You’ve used the guest round on this device');
    expect(root.querySelector('.cap-body')?.textContent).toBe('Your reports and history stay here.');
    expect(root.textContent).not.toMatch(/soon|come back/i);
  });

  it('guest_limits_never_promise_sign_in', async () => {
    for (const reason of LIMIT_REASONS) {
      const root = await renderNode(<CapNotice reason={reason} resetsAt={resets} now={now} />);
      expect(root.textContent).not.toMatch(/sign in/i);
      cleanup();
    }
  });

  it('reads_cap_errors_from_the_server', () => {
    const err = new ApiError(429, 'guest_daily_limit', 'Limit', { code: 'guest_daily_limit', message: 'Limit', resets_at: resets });
    expect(capFromError(err)).toEqual({ reason: 'guest_daily_limit', resetsAt: resets });
    expect(capFromError(new ApiError(500, 'oops', 'x'))).toBeNull();
  });

  it('a_guest_out_of_quick_rounds_can_still_start_the_full_round', () => {
    const me = (full_left: number | null) => ({ limits: { short_left_today: 0, full_left, resets_at: resets, reason: 'guest_daily_limit' } }) as Me;
    expect(capFromMe(me(1), 'full')).toBeNull();
    expect(capFromMe(me(1), 'short')).toEqual({ reason: 'guest_daily_limit', resetsAt: resets });
    expect(capFromMe(me(0), 'full')).toEqual({ reason: 'guest_daily_limit', resetsAt: resets });
  });
});
