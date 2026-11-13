// Plans. Live practice minutes are what costs money; reports and history stay free.
// Checkout is not wired yet, so paid plans show "Coming soon".

import type { Entitlements } from '../../shared/types';
import { loadMe, useAsync } from '../components/data';
import { longDate } from '../components/format';
import { Page } from '../components/Ui';

interface Plan {
  id: 'free' | 'sprint' | 'pro' | 'topup';
  name: string;
  price: string;
  per: string;
  minutes: string;
  points: string[];
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    per: 'with a Google sign in',
    minutes: '2 quick live rounds',
    points: ['Full reports for every round', 'History and skill chart', 'Shareable scorecards'],
  },
  {
    id: 'sprint',
    name: 'Sprint',
    price: '$25',
    per: 'once, for 14 days',
    minutes: '90 live minutes',
    points: ['About eleven quick rounds', 'Daily round and streak', 'Retry any answer'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$39',
    per: 'a month',
    minutes: '150 live minutes a month',
    points: ['Every round and meeting type', 'Daily round and streak', 'Cancel any time'],
  },
  {
    id: 'topup',
    name: 'Top up',
    price: '$15',
    per: 'once',
    minutes: '60 live minutes',
    points: ['Adds to Sprint or Pro', 'Use them any time in your plan period'],
  },
];

function Usage(props: { e: Entitlements }) {
  const { e } = props;
  if (e.minutes_total == null) return null;
  const used = e.minutes_used ?? 0;
  const left = Math.max(0, e.minutes_total - used);
  return (
    <div class="usage" data-test="usage">
      <p>
        <strong class="num">{Math.floor(left)}</strong> of <span class="num">{e.minutes_total}</span> live minutes left
        {e.period_end && <span class="muted">, until {longDate(e.period_end)}</span>}
      </p>
      <div class="progress" role="progressbar" aria-label="Live minutes used" aria-valuemin={0} aria-valuemax={e.minutes_total} aria-valuenow={Math.round(used)}>
        <span style={{ width: `${Math.min(100, (used / e.minutes_total) * 100)}%` }} />
      </div>
    </div>
  );
}

export function Pricing() {
  const me = useAsync(() => loadMe(), []);
  const plan = me.data?.entitlements.plan;
  return (
    <Page test="pricing" title="Plans" lede="Pay for live practice minutes. Reports, history and your skill chart stay free." wide>
      {me.data && <Usage e={me.data.entitlements} />}
      <ul class="plans">
        {PLANS.map((p) => {
          const current = plan === p.id;
          return (
            <li class={`plan${current ? ' plan-current' : ''}${p.id === 'sprint' ? ' plan-lead' : ''}`} key={p.id} data-test={`plan-${p.id}`}>
              <h2 class="plan-name">{p.name}</h2>
              <p class="plan-price">
                <span class="num">{p.price}</span>
                <span class="plan-per">{p.per}</span>
              </p>
              <p class="plan-minutes">{p.minutes}</p>
              <ul class="plan-points">
                {p.points.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              {current ? (
                <p class="plan-badge" data-test="plan-current">
                  Your plan
                </p>
              ) : p.id === 'free' ? null : (
                <button type="button" class="btn" disabled aria-describedby="checkout-soon" data-test="checkout">
                  Coming soon
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div class="plan-notes">
        <p id="checkout-soon">Checkout opens soon. Until then, guests get free quick rounds every day with no sign in.</p>
        <p>
          Quick rounds are one on one. A panel uses minutes for each person in it: a 30 minute full round with two interviewers
          uses 60 minutes.
        </p>
      </div>
    </Page>
  );
}
