// The streak as the last seven days: a filled mark for each practiced day.

import type { Streak as StreakData } from '../../shared/types';
import { plural } from './format';

export function Streak(props: { streak: StreakData; now?: Date }) {
  const { current, best, today_done } = props.streak;
  const now = props.now ?? new Date();
  // Days ending yesterday (or today when today's round is done) are practiced.
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() - (6 - i));
    const back = 6 - i; // 0 = today
    const done = today_done ? back < current : back >= 1 && back <= current;
    return { d, done, today: back === 0 };
  });
  const letter = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const label =
    current === 0
      ? 'No streak yet. A round today starts one.'
      : `${plural(current, 'day')} in a row${today_done ? ', including today' : ''}. Best ${plural(best, 'day')}.`;
  return (
    <div class="streak" data-test="streak" data-current={current}>
      <ol class="streak-days" aria-label={label}>
        {days.map((x, i) => (
          <li key={i} class={`${x.done ? 'on' : ''}${x.today ? ' is-today' : ''}`} aria-hidden="true">
            <span class="streak-dot" />
            <span class="streak-day">{letter.format(x.d)}</span>
          </li>
        ))}
      </ol>
      <p class="streak-text">
        {current > 0 ? (
          <>
            <strong>{plural(current, 'day')}</strong> in a row
            {!today_done && <span class="muted">. Practice today to keep it.</span>}
          </>
        ) : (
          <span class="muted">A round today starts your streak.</span>
        )}
      </p>
    </div>
  );
}
