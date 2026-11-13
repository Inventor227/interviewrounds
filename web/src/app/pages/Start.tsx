// Start page for one round: what happens, "Adjust" (level, style, length; collapsed, with
// defaults), then microphone, headset and Start. Without a headset it offers a preview on this
// screen and a QR code to open the round on a Quest.

import { useLocation } from 'preact-iso';
import { useState } from 'preact/hooks';
import type { Catalog, Level, Me, RoundPublic, Style } from '../../shared/types';
import { LEVELS, STYLES } from '../../shared/types';
import { CapNotice } from '../components/CapNotice';
import { capFromMe, findRound, loadCatalog, loadMe, otherLength, persona, useAsync } from '../components/data';
import { LEVEL_NAMES, ROLE_NAMES, STYLE_NAMES } from '../components/format';
import { ReadyPanel, useHeadset, useMic } from '../components/Ready';
import { Disclosure, ErrorState, Loading, Monogram, Page, Segmented } from '../components/Ui';
import { isFake } from '../fake/mode';
import type { PrepareInput } from '../launch';

const pick = <T extends string>(v: string | undefined, all: readonly T[], fallback: T): T =>
  v && (all as readonly string[]).includes(v) ? (v as T) : fallback;

function StartBody(props: { round: RoundPublic; catalog: Catalog; me?: Me }) {
  const { round, catalog, me } = props;
  const { query, route } = useLocation();
  const retryOf = query.retry || null;
  const [level, setLevel] = useState<Level>(pick(query.level, LEVELS, me?.settings.default_level ?? 'mid'));
  const [style, setStyle] = useState<Style>(pick(query.style, STYLES, me?.settings.default_style ?? 'neutral'));
  const mic = useMic();
  const xr = useHeadset(query.preview === '1');
  const other = otherLength(catalog, round);
  const lead = persona(catalog, round.panel.lead);
  const second = persona(catalog, round.panel.second);
  const cap = capFromMe(me, round.length);

  const params = new URLSearchParams();
  if (level !== 'mid') params.set('level', level);
  if (style !== 'neutral') params.set('style', style);
  if (retryOf) params.set('retry', retryOf);
  const qs = params.toString();
  const here = typeof location === 'undefined' ? '' : location.origin;
  const questUrl = `${here}/round/${round.id}${qs ? `?${qs}` : ''}`;

  const setLength = (len: 'short' | 'full') => {
    if (len === round.length || !other) return;
    route(`/round/${other.id}${qs ? `?${qs}` : ''}`, true);
  };

  const voice = isFake() ? 'fake' : 'fish';
  const input: PrepareInput = retryOf
    ? { kind: 'retry', parentSessionId: retryOf, voice }
    : { kind: 'new', req: { mode: 'interview', round_id: round.id, length: round.length, level, style, voice } };

  const lengthLabel = round.length === 'short' ? 'Quick' : 'Full';
  return (
    <>
      <div class="start-intro">
        {lead && (
          <div class="who">
            <Monogram name={lead.display_name} size="lg" />
            {second && <Monogram name={second.display_name} size="lg" />}
            <p class="who-text">
              <strong>{lead.display_name}</strong>, {lead.title}
              {second && (
                <>
                  , then <strong>{second.display_name}</strong>, {second.title}
                </>
              )}
            </p>
          </div>
        )}
        {round.summary && <p class="start-summary">{round.summary}</p>}
        {retryOf ? (
          <p class="note" data-test="retry-note">
            This is a two minute retry of your weakest answer. It is scored again, and your report shows before and after.
          </p>
        ) : (
          <ol class="phases" aria-label="What happens">
            {round.phases.map((p) => (
              <li key={p.id} style={{ flexGrow: p.minutes }}>
                <span class="phase-name">{p.title ?? p.id}</span>
                <span class="phase-min num">{p.minutes} min</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {!retryOf && (
        <Disclosure
          test="adjust"
          class="adjust"
          summary={
            <>
              <span class="adjust-label">Adjust</span>
              <span class="adjust-now" data-test="adjust-summary">
                {LEVEL_NAMES[level]} level, {STYLE_NAMES[style].toLowerCase()} interviewer, {lengthLabel.toLowerCase()} round
              </span>
            </>
          }
        >
          <Segmented
            name="level"
            legend="Your level"
            value={level}
            onChange={setLevel}
            choices={LEVELS.map((l) => ({ value: l, label: LEVEL_NAMES[l] }))}
          />
          <Segmented
            name="style"
            legend="Interviewer style"
            value={style}
            onChange={setStyle}
            choices={STYLES.map((s) => ({ value: s, label: STYLE_NAMES[s] }))}
          />
          {other && (
            <Segmented
              name="length"
              legend="Length"
              value={round.length}
              onChange={setLength}
              choices={(round.length === 'short' ? [round, other] : [other, round]).map((r) => ({ value: r.length, label: `${r.length === 'short' ? 'Quick' : 'Full'}, ${r.target_minutes} min` }))}
            />
          )}
        </Disclosure>
      )}

      <ReadyPanel
        mic={mic}
        xr={xr}
        questUrl={questUrl}
        input={input}
        title={round.title}
        me={me}
        enterLabel={retryOf ? (xr === 'none' ? 'Retry on this screen' : 'Enter the room for the retry') : undefined}
        blocked={
          cap ? (
            <CapNotice reason={cap.reason} resetsAt={cap.resetsAt} isGuest={me?.identity.kind !== 'user'} signInAvailable={me?.sign_in_available} />
          ) : undefined
        }
      />
    </>
  );
}

export function Start(props: { roundId?: string }) {
  const id = props.roundId ?? '';
  const catalog = useAsync(() => loadCatalog(), []);
  const me = useAsync(() => loadMe(), []);
  const { query } = useLocation();
  const round = catalog.data ? findRound(catalog.data, id) : undefined;
  const role = round?.role && round.role !== 'none' ? round.role : null;

  const title =
    catalog.status !== 'ready' ? 'Get ready' : !round ? 'Round not found' : query.retry ? 'Retry this answer' : round.title;
  const lede = round
    ? `${round.target_minutes} minute ${round.length === 'short' ? 'quick' : 'full'} round${role ? ` for ${ROLE_NAMES[role]}` : ''}.`
    : undefined;

  return (
    <Page
      test="start"
      title={title}
      lede={lede}
      back={role ? { href: `/start/${role}`, label: `${ROLE_NAMES[role]} rounds` } : { href: '/start', label: 'All rounds' }}
      attrs={{ 'data-round': id }}
    >
      {catalog.status === 'loading' && <Loading rows={4} />}
      {catalog.status === 'error' && <ErrorState error={catalog.error} onRetry={catalog.reload} />}
      {catalog.status === 'ready' && !round && (
        <div class="state" data-test="round-missing">
          <p>That round does not exist. It may have been renamed.</p>
          <a class="btn" href="/start">
            Pick a round
          </a>
        </div>
      )}
      {catalog.status === 'ready' && round && me.status !== 'loading' && <StartBody round={round} catalog={catalog.data} me={me.data} />}
    </Page>
  );
}
