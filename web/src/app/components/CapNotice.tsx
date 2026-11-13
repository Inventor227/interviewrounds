// Shown instead of a Start button when a cap blocks a new round, for every CapError reason.
// The reset time is in the viewer's local time.

import type { LimitReason } from '../../shared/types';
import { links } from '../../net/api';
import { resetPhrase } from './format';

const COPY: Record<LimitReason, { title: string; body: string }> = {
  guest_daily_limit: {
    title: 'You have used today’s free rounds',
    body: 'Guest rounds come back',
  },
  guest_full_used: {
    title: 'Your full round is used',
    body: 'Quick rounds are still open. Another full round opens',
  },
  judge_budget_reached: {
    title: 'Guest practice is full for today',
    body: 'Every guest round for today is taken. It opens again',
  },
  build_budget_reached: {
    title: 'Live rounds are paused',
    body: 'Live practice is paused for now. Reports and history still work. Live rounds come back',
  },
  model_budget_reached: {
    title: 'Rounds are fully booked for today',
    body: 'Every live round for today is taken. They open again',
  },
  free_rounds_used: {
    title: 'You have used your free rounds',
    body: 'Your reports and history stay free. Pick a plan to keep practicing live.',
  },
  model_budget_reached: {
    title: 'Live rounds are paused',
    body: 'Live practice is paused for now. Reports and history still work. Live rounds come back',
  },
};

export function CapNotice(props: {
  reason: LimitReason;
  resetsAt: string | null;
  signInAvailable?: boolean;
  isGuest?: boolean;
  now?: Date;
}) {
  const c = COPY[props.reason];
  const withTime = props.reason !== 'free_rounds_used';
  return (
    <div class="cap" role="status" data-test="cap-notice" data-reason={props.reason}>
      <svg class="cap-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <div>
        <h2 class="cap-title">{c.title}</h2>
        <p class="cap-body">
          {c.body}
          {withTime &&
            (props.resetsAt ? (
              <>
                {' '}
                <time dateTime={props.resetsAt} data-test="cap-reset">
                  {resetPhrase(props.resetsAt, props.now)}
                </time>
                .
              </>
            ) : (
              ' soon.'
            ))}
        </p>
        <div class="row">
          {props.reason === 'free_rounds_used' && (
            <a class="btn btn-primary" href="/pricing" data-test="cap-plans">
              See plans
            </a>
          )}
          {props.reason === 'guest_full_used' && (
            <a class="btn" href="/start" data-test="cap-quick">
              Pick a quick round
            </a>
          )}
          {props.isGuest && props.signInAvailable && props.reason !== 'build_budget_reached' && (
            <a class="btn" href={links.googleSignIn} data-test="cap-sign-in">
              Sign in to keep your history
            </a>
          )}
          <a class="btn btn-quiet" href="/history" data-test="cap-history">
            Your reports
          </a>
        </div>
      </div>
    </div>
  );
}
