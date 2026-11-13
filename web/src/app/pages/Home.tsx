// Home: one headline, one button (a preset quick system design round, no sign in), a resume
// banner after a drop, today's round with the streak, and quieter links to everything else.

import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { links } from '../../net/api';
import type { Catalog, Me } from '../../shared/types';
import { CapNotice } from '../components/CapNotice';
import { capFromMe, findRound, loadCatalog, loadMe, persona, useAsync } from '../components/data';
import { clock } from '../components/format';
import { askMic, holdMic, useHeadset } from '../components/Ready';
import { Streak } from '../components/Streak';
import { Monogram } from '../components/Ui';
import { isFake } from '../fake/mode';
import { prepareLaunch, type PrepareInput } from '../launch';
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
        <p class="banner-title">Your {props.r.round_title} round dropped</p>
        <p class="banner-text">
          Pick up where you left off for the next <span class="num" data-test="resume-left">{clock(left)}</span>. After that it is
          scored as far as it went.
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
  const lead = persona(props.catalog, round?.panel.lead);
  if (!props.me) return <aside class="today today-empty" aria-hidden="true" />;
  return (
    <aside class="today" aria-labelledby="today-title" data-test="today">
      <p class="today-when">Today’s round</p>
      {daily ? (
        <>
          <h2 id="today-title" class="today-title">
            {daily.title}
          </h2>
          {round && (
            <p class="today-meta">
              <span class="num">{round.target_minutes}</span> min quick round
            </p>
          )}
          {lead && (
            <div class="today-who">
              <Monogram name={lead.display_name} />
              <div>
                <p class="today-name">{lead.display_name}</p>
                <p class="today-role">{lead.title}</p>
              </div>
            </div>
          )}
        </>
      ) : (
        <h2 id="today-title" class="today-title">
          Your streak
        </h2>
      )}
      <Streak streak={props.me.streak} />
      {daily && (
        <a class="btn btn-small" href={`/round/${daily.round_id}`} data-test="today-start">
          Start today’s round
        </a>
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

  const m = me.data;
  const cap = capFromMe(m, 'short');
  const guest = m?.identity.kind !== 'user';
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
      const preview = xr === 'none';
      const input: PrepareInput = {
        kind: 'new',
        req: {
          mode: 'interview',
          round_id: PRESET_ROUND,
          length: 'short',
          level: m?.settings.default_level ?? 'mid',
          style: m?.settings.default_style ?? 'neutral',
          voice: isFake() ? 'fake' : 'fish',
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
          <p class="lede">Interview rounds and real meetings, out loud, in your own room. Then a scorecard that quotes you.</p>
          {cap ? (
            <CapNotice reason={cap.reason} resetsAt={cap.resetsAt} isGuest={guest} signInAvailable={m?.sign_in_available} />
          ) : (
            <div class="hero-cta">
              <a class="btn btn-primary btn-big" href={href} onClick={(e) => void onStart(e)} aria-busy={asking} data-test="try-quick">
                Start a quick round
              </a>
              <p class="fine" data-test="try-quick-note">
                {asking ? 'Allow the microphone in the browser prompt.' : 'System design, 8 minutes, no sign in. It asks for your mic once.'}
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

      <div class="home-foot">
        <a href="/history" data-test="history-link">
          Your past rounds and progress
        </a>
        {m?.sign_in_available && guest && (
          <a href={links.googleSignIn} data-test="sign-in">
            Sign in to keep your history on every device
          </a>
        )}
      </div>
    </section>
  );
}
