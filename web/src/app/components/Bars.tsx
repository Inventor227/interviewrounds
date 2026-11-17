// Competency bars: a score from 1 to 4 against the bar for the chosen level (3 = meets the bar),
// with a "vs last time" arrow.

import type { Competency } from '../../shared/types';

const LEVEL_TEXT: Record<NonNullable<Competency['level_label']>, string> = {
  below: 'Below the bar',
  developing: 'Developing',
  meets_bar: 'Meets the bar',
  above_bar: 'Above the bar',
  not_observed: 'Not observed',
};

function levelOf(c: Competency): NonNullable<Competency['level_label']> {
  if (c.level_label) return c.level_label;
  if (c.score == null) return 'not_observed';
  return c.score >= 4 ? 'above_bar' : c.score >= 3 ? 'meets_bar' : c.score >= 2 ? 'developing' : 'below';
}

export function Delta(props: { delta: number | null | undefined }) {
  const d = props.delta;
  if (d == null) return null;
  const amount = Math.abs(Math.round(d * 10) / 10);
  if (d === 0)
    return (
      <span class="delta delta-same" data-test="delta" data-dir="same">
        <span aria-hidden="true">=</span> Same as last time
      </span>
    );
  const up = d > 0;
  return (
    <span class={`delta ${up ? 'delta-up' : 'delta-down'}`} data-test="delta" data-dir={up ? 'up' : 'down'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? 'Up' : 'Down'} {amount} vs last time
    </span>
  );
}

/** compact: no reason under each bar (the report folds them into one list below). */
export function Bars(props: { competencies: Competency[]; compact?: boolean }) {
  return (
    <ul class="bars" data-test="bars">
      {props.competencies.map((c) => {
        const level = levelOf(c);
        const score = c.score;
        return (
          <li class={`bar-row lvl-${level}`} key={c.id} data-test="bar" data-id={c.id} data-score={score ?? ''}>
            <div class="bar-head">
              <span class="bar-name">{c.name}</span>
              <span class="bar-score">
                {score == null ? (
                  <span class="muted">Not observed</span>
                ) : (
                  <>
                    <strong class="num">{Number.isInteger(score) ? score : score.toFixed(1)}</strong>
                    <span class="muted"> of 4</span>
                  </>
                )}
              </span>
            </div>
            <div
              class="bar-track"
              role="meter"
              aria-valuemin={1}
              aria-valuemax={4}
              aria-valuenow={score ?? undefined}
              aria-valuetext={score == null ? 'Not observed' : `${score} of 4, ${LEVEL_TEXT[level].toLowerCase()}`}
              aria-label={c.name}
            >
              {[1, 2, 3, 4].map((n) => (
                <span key={n} class={`bar-cell${score != null && n <= Math.round(score) ? ' on' : ''}${n === 3 ? ' bar-mark' : ''}`} />
              ))}
            </div>
            <div class="bar-foot">
              <span class="bar-level">{LEVEL_TEXT[level]}</span>
              <Delta delta={c.delta_vs_last} />
            </div>
            {!props.compact && c.rationale && score != null && <p class="bar-why">{c.rationale}</p>}
          </li>
        );
      })}
    </ul>
  );
}
