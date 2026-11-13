// Each competency over the last ten sessions, scored 1 to 4, with the bar (3) drawn as a line.
// A table carries the same numbers for screen readers.

import type { Skills } from '../../shared/types';
import { dayLabel } from './format';

const MAX_SESSIONS = 10;
const W = 640;
const H = 220;
const PAD = { l: 28, r: 12, t: 12, b: 26 };

export function SkillChart(props: { skills: Skills }) {
  const comps = props.skills.competencies.filter((c) => c.points.length > 0);
  if (comps.length === 0) return null;

  // Sessions across all competencies, oldest first, last ten.
  const sessions = new Map<string, string>();
  for (const c of comps) for (const p of c.points) if (!sessions.has(p.session_id)) sessions.set(p.session_id, p.at);
  const order = [...sessions.entries()].sort((a, b) => a[1].localeCompare(b[1])).slice(-MAX_SESSIONS);
  const index = new Map(order.map(([id], i) => [id, i]));
  const n = order.length;

  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (s: number) => PAD.t + ((4 - s) * (H - PAD.t - PAD.b)) / 3;

  return (
    <figure class="chart" data-test="skill-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="chart-cap" class="chart-svg">
        {[1, 2, 3, 4].map((s) => (
          <g key={s}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(s)} y2={y(s)} class={s === 3 ? 'grid grid-bar' : 'grid'} />
            <text x={PAD.l - 10} y={y(s) + 4} class="axis" text-anchor="end">
              {s}
            </text>
          </g>
        ))}
        {comps.map((c, ci) => {
          // A small vertical offset per series keeps equal scores from hiding each other.
          const dy = (ci - (comps.length - 1) / 2) * 3;
          const pts = c.points
            .filter((p) => index.has(p.session_id))
            .map((p) => [x(index.get(p.session_id)!), y(p.score) + dy] as const);
          if (pts.length === 0) return null;
          return (
            <g key={c.id} class={`series c${ci % 4}`}>
              <polyline points={pts.map((p) => p.join(',')).join(' ')} vector-effect="non-scaling-stroke" />
              {pts.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={i === pts.length - 1 ? 4.5 : 3} vector-effect="non-scaling-stroke" />
              ))}
            </g>
          );
        })}
        {n > 1 && (
          <>
            <text x={x(0)} y={H - 6} class="axis" text-anchor="start">
              {dayLabel(order[0]![1])}
            </text>
            <text x={x(n - 1)} y={H - 6} class="axis" text-anchor="end">
              {dayLabel(order[n - 1]![1])}
            </text>
          </>
        )}
      </svg>
      <figcaption id="chart-cap" class="chart-legend">
        <span class="sr-only">Your scores from 1 to 4 over your last {n} sessions. 3 meets the bar.</span>
        <ul>
          {comps.map((c, ci) => {
            const last = c.points[c.points.length - 1];
            const prev = c.points[c.points.length - 2];
            const d = last && prev ? last.score - prev.score : null;
            return (
              <li key={c.id} class={`c${ci % 4}`}>
                <span class="swatch" aria-hidden="true" />
                <span class="legend-name">{c.name}</span>
                <span class="legend-val num">
                  {last?.score ?? ''}
                  {d != null && d !== 0 && (
                    <span class={d > 0 ? 'delta-up' : 'delta-down'}>
                      {' '}
                      <span aria-hidden="true">{d > 0 ? '▲' : '▼'}</span>
                      <span class="sr-only">{d > 0 ? 'up' : 'down'} from last time</span>
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </figcaption>
      <table class="sr-only">
        <caption>Scores by session</caption>
        <thead>
          <tr>
            <th scope="col">Competency</th>
            {order.map(([id, at]) => (
              <th scope="col" key={id}>
                {dayLabel(at)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comps.map((c) => (
            <tr key={c.id}>
              <th scope="row">{c.name}</th>
              {order.map(([id]) => (
                <td key={id}>{c.points.find((p) => p.session_id === id)?.score ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
