// A strength or weakness with the quotes behind it. When the report has a recording, the
// timestamp is a play button that plays that moment.

import type { Evidence, ReportPoint } from '../../shared/types';
import { clock } from './format';

export interface Player {
  play(from: number, to?: number): void;
  playing: number | null;
}

export function QuoteRow(props: {
  point: ReportPoint;
  evidence: Evidence[];
  tone: 'good' | 'bad';
  player: Player | null;
}) {
  const quotes = props.point.evidence_ids
    .map((id) => props.evidence.find((e) => e.id === id))
    .filter((e): e is Evidence => !!e);
  return (
    <li class={`point point-${props.tone}`} data-test="point">
      <h3 class="point-title">{props.point.title}</h3>
      <p class="point-detail">{props.point.detail}</p>
      {quotes.map((q) => (
        <Quote key={q.id} q={q} player={props.player} />
      ))}
    </li>
  );
}

export function Quote(props: { q: Evidence; player: Player | null }) {
  const { q, player } = props;
  const at = clock(q.t_start_sec);
  return (
    <figure class="quote" data-test="quote" data-t={q.t_start_sec}>
      <blockquote>“{q.quote}”</blockquote>
      <figcaption>
        {player ? (
          <button
            type="button"
            class={`play${player.playing === q.t_start_sec ? ' is-playing' : ''}`}
            onClick={() => player.play(q.t_start_sec, q.t_end_sec)}
            data-test="play"
            aria-label={`Play this moment at ${at}`}
          >
            <span aria-hidden="true">▶</span> {at}
          </button>
        ) : (
          <span class="stamp" data-test="stamp">
            {at}
          </span>
        )}
        {q.note && <span class="quote-note">{q.note}</span>}
      </figcaption>
    </figure>
  );
}
