// Rounds for one role: a tile per round with "N min quick" and one line on what happens, plus a
// link to the full length round.

import type { Catalog } from '../../shared/types';
import { loadCatalog, otherLength, persona, useAsync } from '../components/data';
import { ROLE_NAMES } from '../components/format';
import { Tile } from '../components/Tile';
import { ErrorState, Loading, Monogram, Page } from '../components/Ui';

function Rounds(props: { catalog: Catalog; role: string }) {
  const quick = props.catalog.rounds.filter((r) => r.role === props.role && r.length === 'short');
  if (quick.length === 0) {
    return (
      <div class="state" data-test="empty">
        <h2>No rounds here yet</h2>
        <p>Pick another role, or rehearse a real meeting.</p>
        <a class="btn" href="/start">
          See all roles
        </a>
      </div>
    );
  }
  return (
    <ul class="round-list">
      {quick.map((r) => {
        const full = otherLength(props.catalog, r);
        const lead = persona(props.catalog, r.panel.lead);
        return (
          <li class="round-item" key={r.id}>
            <Tile href={`/round/${r.id}`} test={`round-${r.id}`} title={r.title} meta={<span class="num">{r.target_minutes} min quick</span>}>
              {r.summary}
              {lead && (
                <span class="tile-who">
                  <Monogram name={lead.display_name} size="sm" />
                  With {lead.display_name}, {lead.title}
                </span>
              )}
            </Tile>
            {full && (
              <a class="round-full" href={`/round/${full.id}`} data-test={`round-${full.id}`}>
                Or the full round,{' '}
                <span class="num">{full.target_minutes} min</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PickRound(props: { role?: string }) {
  const role = props.role ?? '';
  const catalog = useAsync(() => loadCatalog(), []);
  const name = ROLE_NAMES[role];
  return (
    <Page
      test="pick-round"
      title={name ? `${name} rounds` : 'Pick a round'}
      lede="Each one starts in about a minute. Quick rounds are one on one."
      back={{ href: '/start', label: 'All roles' }}
    >
      {catalog.status === 'loading' && <Loading rows={4} />}
      {catalog.status === 'error' && <ErrorState error={catalog.error} onRetry={catalog.reload} />}
      {catalog.status === 'ready' && <Rounds catalog={catalog.data} role={role} />}
    </Page>
  );
}
