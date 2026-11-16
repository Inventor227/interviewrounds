// History: progress per competency over time, and every round, newest first, filterable by role.

import { useLocation } from 'preact-iso';
import { api } from '../../net/api';
import type { HistoryItem, Role } from '../../shared/types';
import { useAsync } from '../components/data';
import { dayLabel, timeOfDay } from '../components/format';
import { SkillChart } from '../components/SkillChart';
import { ErrorState, Loading, Page, Segmented } from '../components/Ui';

type Filter = 'all' | Role;

function Item(props: { item: HistoryItem }) {
  const i = props.item;
  const at = new Date(i.started_at);
  return (
    <li>
      <a class="hist" href={`/report/${encodeURIComponent(i.session_id)}`} data-test="history-item">
        <span class="hist-when">
          <span>{dayLabel(i.started_at)}</span>
          <span class="muted num">{timeOfDay(at)}</span>
        </span>
        <span class="hist-main">
          <strong class="hist-title">{i.title}</strong>
          <span class="hist-line">{i.headline}</span>
        </span>
      </a>
    </li>
  );
}

export function History() {
  const { query, route } = useLocation();
  const filter: Filter = query.role === 'sde' || query.role === 'pm' ? query.role : 'all';
  const role = filter === 'all' ? undefined : filter;
  const items = useAsync(() => api.history(role), [filter]);
  const skills = useAsync(() => api.skills(role), [filter]);

  return (
    <Page test="history" title="Your rounds" lede="Your progress and every report.">
      <Segmented
        name="role"
        legend="Show"
        hideLegend
        value={filter}
        onChange={(v) => route(v === 'all' ? '/history' : `/history?role=${v}`, true)}
        choices={[
          { value: 'all', label: 'All' },
          { value: 'sde', label: 'Software Engineer' },
          { value: 'pm', label: 'Product Manager' },
        ]}
      />

      {items.status === 'loading' && <Loading rows={4} />}
      {items.status === 'error' && <ErrorState error={items.error} onRetry={items.reload} />}
      {items.status === 'ready' && items.data.length === 0 && (
        <div class="state state-empty" data-test="history-empty">
          <h2>No rounds yet</h2>
          <p>Your reports show up here.</p>
          <a class="btn btn-primary" href="/start">
            Try a quick round
          </a>
        </div>
      )}
      {items.status === 'ready' && items.data.length > 0 && (
        <>
          {skills.status === 'ready' && skills.data.competencies.some((c) => c.points.length > 1) && (
            <section class="hist-chart" aria-labelledby="chart-title">
              <h2 id="chart-title" class="section-title">
                Skills over time
              </h2>
              <SkillChart skills={skills.data} />
            </section>
          )}
          <section aria-labelledby="list-title">
            <h2 id="list-title" class="section-title">
              Reports
            </h2>
            <ul class="hist-list" data-test="history-list">
              {items.data.map((i) => (
                <Item key={i.session_id} item={i} />
              ))}
            </ul>
          </section>
        </>
      )}
    </Page>
  );
}
