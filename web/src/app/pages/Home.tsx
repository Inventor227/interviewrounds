// Home: one headline, one button (a preset quick system design round), a resume banner after a
// drop, three icon steps, a compact streak card with today's round as a link, and quieter links.

import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { Catalog, Me } from '../../shared/types';
import { CapNotice } from '../components/CapNotice';
import { capFromMe, findRound, loadCatalog, loadMe, useAsync } from '../components/data';
import { clock } from '../components/format';
import { askMic, checkHeadset, holdMic, useHeadset } from '../components/Ready';
import { Streak } from '../components/Streak';
import { voiceChoice } from '../voiceChoice';
import { prepareLaunch, type PrepareInput } from '../launch';
import { prefetchRoom } from '../prefetch';
import { HowItWorks } from './Onboarding';

export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function ResumeBanner(props: { r: NonNullable<Me['resumable']> }) {
  const now = useNow();
  const left = Math.max(0, (Date.parse(props.r.expires_at) - now) / 1000);
  if (left <= 0) return null;
  return (
    <div class="banner" role="region" aria-label="Resume your round" data-test="resume-banner">
      <div>
        <p class="banner-title" data-test="resume-title">{props.r.paused ? 'Your round is paused' : `Your ${props.r.round_title} round dropped`}</p>
        <p class="banner-text">
          {props.r.paused ? 'Your interviewer is waiting. Come back within' : 'Pick up where you left off within'}{' '}
          <span class="num" data-test="resume-left">{clock(left)}</span>.
        </p>
      </div>
      <a class="btn btn-primary" href={`/resume/${encodeURIComponent(props.r.session_id)}`} data-test="resume">
        Resume round
      </a>
    </div>
  );
}

function TodayCard(props: { me?: Me; catalog?: Catalog }) {
  const daily = props.me?.daily;
  const round = props.catalog && daily ? findRound(props.catalog, daily.round_id) : undefined;
  if (!props.me) return <aside class="today today-empty" aria-hidden="true" />;
  return (
    <aside class="today" aria-labelledby="today-title" data-test="today">
      <h2 id="today-title" class="today-title">
        Your streak
      </h2>
      <Streak streak={props.me.streak} />
      {daily && (
        <p class="today-line">
          Today:{' '}
          <a href={`/round/${daily.round_id}`} data-test="today-start">
            {daily.title}
            {round && (
              <>
                , <span class="num">{round.target_minutes}</span> min
              </>
            )}
          </a>
        </p>
      )}
    </aside>
  );
}

/** Home's one button: a preset quick system design round. */
export const PRESET_ROUND = 'sde.system_design.short';

export function Home() {
  const me = useAsync(() => loadMe(), []);
  const catalog = useAsync(() => loadCatalog(), []);
  const xr = useHeadset();
  const { route } = useLocation();
  const [asking, setAsking] = useState(false);
  // The room's code loads while this page is idle, so the first tap does not wait for it.
  useEffect(() => prefetchRoom(), []);

  const m = me.data;
  const cap = capFromMe(m, 'short');
  const href = `/round/${PRESET_ROUND}`;

  // Phase A rides on this tap (the mic prompt, then the session and the room load), so the Start
  // page needs only one more: Enter the room.
  const onStart = async (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    // The router's link handler ignores preventDefault: keep it from moving on before the prompt.
    e.stopPropagation();
    if (asking) return;
    setAsking(true);
    const from = location.pathname;
    const out = await askMic();
    setAsking(false);
    // The user went elsewhere while the prompt was open: do not pull them back.
    if (location.pathname !== from) {
      out.stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    if (out.stream) {
      // The same cached check the Start page uses, so both agree on preview.
      const preview = (await checkHeadset()) === 'none';
      const input: PrepareInput = {
        kind: 'new',
        req: {
          mode: 'interview',
          round_id: PRESET_ROUND,
          length: 'short',
          level: m?.settings.default_level ?? 'mid',
          style: m?.settings.default_style ?? 'neutral',
          voice: voiceChoice(),
        },
      };
      void prepareLaunch(input, { mic: out.stream, preview, title: 'System design' });
      holdMic({ state: 'allowed', stream: null });
    } else {
      holdMic(out);
    }
    route(href);
  };

  return (
    <section class="pg home" data-test="page-home" aria-labelledby="h-home">
      {m?.resumable && <ResumeBanner r={m.resumable} />}

      <div class="hero">
        <div class="hero-main">
          <h1 id="h-home" class="display">
            Practice with people across your desk
          </h1>
          <p class="lede">Rehearse interviews and meetings out loud. Get a scorecard that quotes you.</p>
          {cap ? (
            <CapNotice reason={cap.reason} resetsAt={cap.resetsAt} />
          ) : (
            <div class="hero-cta">
              <a class="btn btn-primary btn-big" href={href} onClick={(e) => void onStart(e)} aria-busy={asking} data-test="try-quick">
                Start a quick round
              </a>
              <p class="fine" data-test="try-quick-note">
                {asking ? 'Allow the mic in the browser prompt.' : 'System design, 8 min. Uses your mic.'}
              </p>
            </div>
          )}
          <div class="hero-links">
            <a href="/start" data-test="choose-round">
              Choose another round
            </a>
            <a href="/meeting/new" data-test="tile-meeting">
              Rehearse a real meeting
            </a>
          </div>
        </div>
        <TodayCard me={m} catalog={catalog.data} />
      </div>

      <HowItWorks />
    </section>
  );
}
