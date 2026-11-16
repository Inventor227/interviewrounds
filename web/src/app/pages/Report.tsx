// The full report, in the order of the scorecard spec: verdict, competencies, strengths,
// weaknesses, weakest moment with Retry, next drills, delivery, transcript and board, share.
// Also: scoring in progress (polls until ready), not enough signal, meeting outcome, failed.

import { Component, type ComponentChildren, type JSX } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../../net/api';
import type { Catalog, Delivery, Evidence, MeetingDetails, NextDrill, Report as ReportData, SessionStatus } from '../../shared/types';
import { Bars } from '../components/Bars';
import { loadCatalog, persona, toApiError, useAsync } from '../components/data';
import { clock, LEVEL_NAMES, longDate, pct, plural } from '../components/format';
import { QuoteRow, type Player } from '../components/QuoteRow';
import { Disclosure, ErrorState, Loading, Page } from '../components/Ui';
import { MeetingOutcome, Verdict } from '../components/Verdict';
import { fakeReady } from '../fake/mode';

const POLL_MS = 2500;
/** Scoring usually finishes in this long; the progress estimate is based on it. */
const EXPECTED_SCORING_MS = 30_000;
/** Past this, say the report will land in History. */
export const SLOW_SCORING_MS = 60_000;

/** Fields the server may add beyond report.v1 (recording and transcript). Read defensively. */
interface ReportExtras {
  recording_url?: unknown;
  transcript?: unknown;
}

export function recordingUrl(r: ReportData): string | null {
  const u = (r as ReportData & ReportExtras).recording_url;
  return typeof u === 'string' && u ? u : null;
}

interface Line {
  t: number;
  speaker: string;
  text: string;
}

export function transcriptOf(r: ReportData): Line[] | null {
  const t = (r as ReportData & ReportExtras).transcript;
  if (!Array.isArray(t)) return null;
  const lines = t
    .map((x) => x as { t_sec?: unknown; speaker?: unknown; text?: unknown })
    .filter((x) => typeof x.text === 'string')
    .map((x) => ({ t: typeof x.t_sec === 'number' ? x.t_sec : 0, speaker: typeof x.speaker === 'string' ? x.speaker : 'user', text: x.text as string }));
  return lines.length ? lines : null;
}

type View =
  | { kind: 'loading' }
  | { kind: 'ready'; report: ReportData }
  | { kind: 'waiting'; status: SessionStatus; since: number }
  | { kind: 'failed' }
  | { kind: 'abandoned' }
  | { kind: 'error'; error: ApiError };

/** A retry's page moves to its parent's address and hands over the report it already has (no second load). */
let handoff: ReportData | null = null;

function useReport(id: string): [View, () => void] {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const since = Date.now();
    const handed = handoff;
    handoff = null;
    if (handed && handed.session.id === id) {
      setView({ kind: 'ready', report: handed });
      return;
    }
    setView({ kind: 'loading' });
    const poll = async () => {
      try {
        const report = await api.report(id);
        if (live) setView({ kind: 'ready', report });
        return;
      } catch (err) {
        const e = toApiError(err);
        if (e.status !== 404) {
          if (live) setView({ kind: 'error', error: e });
          return;
        }
      }
      try {
        const st = await api.sessionStatus(id);
        if (!live) return;
        if (st.status === 'failed') return setView({ kind: 'failed' });
        if (st.status === 'abandoned') return setView({ kind: 'abandoned' });
        setView({ kind: 'waiting', status: st.status, since });
        timer = setTimeout(() => void poll(), POLL_MS);
      } catch (err) {
        if (live) setView({ kind: 'error', error: toApiError(err) });
      }
    };
    void fakeReady.then(poll);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, tick]);
  return [view, () => setTick((t) => t + 1)];
}

// ---------- Player ----------

function usePlayer(url: string | null): [Player | null, JSX.Element | null] {
  const audio = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  if (!url) return [null, null];
  const player: Player = {
    playing,
    play(from, to) {
      const a = audio.current;
      if (!a) return;
      if (playing === from && !a.paused) {
        a.pause();
        return;
      }
      a.currentTime = from;
      stopAt.current = to ?? from + 30;
      setPlaying(from);
      void a.play().catch(() => setPlaying(null));
    },
  };
  const el = (
    <audio
      ref={audio}
      src={url}
      preload="none"
      onTimeUpdate={(e) => {
        const a = e.currentTarget;
        if (stopAt.current != null && a.currentTime >= stopAt.current + 0.4) a.pause();
      }}
      onPause={() => setPlaying(null)}
      onEnded={() => setPlaying(null)}
    />
  );
  return [player, el];
}

// ---------- Sections ----------

function Section(props: { name: string; title: string; children: ComponentChildren; hideTitle?: boolean; lede?: string; fold?: boolean; count?: number }) {
  if (props.fold) {
    // Folded: the heading is the toggle. Content stays in the page (find in page, tests), shown on demand.
    return (
      <details class={`rsec rsec-fold rsec-${props.name}`} data-test={`report-section-${props.name}`}>
        <summary>
          <h2 id={`rs-${props.name}`} class="rsec-title">
            {props.title}
            {props.count != null && <span class="rsec-count num"> {props.count}</span>}
          </h2>
        </summary>
        <div class="rsec-body">
          {props.lede && <p class="rsec-lede">{props.lede}</p>}
          {props.children}
        </div>
      </details>
    );
  }
  return (
    <section class={`rsec rsec-${props.name}`} data-test={`report-section-${props.name}`} aria-labelledby={`rs-${props.name}`}>
      <h2 id={`rs-${props.name}`} class={props.hideTitle ? 'sr-only' : 'rsec-title'}>
        {props.title}
      </h2>
      {props.lede && <p class="rsec-lede">{props.lede}</p>}
      {props.children}
    </section>
  );
}

/** A retry is offered when the report has a retry prompt (interview rounds only). */
function canRetry(r: ReportData): boolean {
  return r.session.mode === 'interview' && !!r.weakest_moment?.retry?.prompt;
}

function retryHref(r: ReportData): string {
  const round = r.session.round_id ?? (r.session.mode === 'meeting' ? 'meeting.short' : `${r.session.role}.${r.session.round_type}.short`);
  return `/round/${round}?retry=${encodeURIComponent(r.session.id)}`;
}

function drillHref(d: NextDrill, r: ReportData): string | null {
  switch (d.kind) {
    case 'retry_answer':
      return canRetry(r) ? retryHref(r) : null;
    case 'meeting':
      return '/meeting/new';
    case 'short_round':
    case 'full_round': {
      if (d.round_id) return `/round/${d.round_id}`;
      const role = r.session.role && r.session.role !== 'none' ? r.session.role : null;
      const type = d.round_type ?? r.session.round_type;
      return role ? `/round/${role}.${type}.${d.kind === 'short_round' ? 'short' : 'full'}` : null;
    }
    default:
      return null;
  }
}

const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** True when two lines say the same thing (case and punctuation aside). */
export function sameWords(a: string, b: string): boolean {
  return words(a) === words(b);
}

function NoSignal(props: { r: ReportData; meeting: boolean }) {
  const mins = Math.max(1, Math.round(props.r.session.duration_sec / 60));
  const again = props.meeting ? '/meeting/new' : props.r.session.round_id ? `/round/${props.r.session.round_id}` : '/start';
  const label = props.meeting ? 'No decision recorded' : 'Not enough signal yet';
  return (
    <div class="nosignal" data-test="no-signal" data-kind={props.meeting ? 'meeting' : 'interview'}>
      <p class="chip chip-mid">
        <span class="chip-name">{label}</span>
      </p>
      {/* The server's summary for such a round is often the same words as the chip: say it once. */}
      {sameWords(props.r.headline.summary, label) ? null : <p class="verdict-summary">{props.r.headline.summary}</p>}
      <p>
        {props.meeting
          ? `The meeting lasted about ${plural(mins, 'minute')} and ended before a decision.`
          : `We score after two full answers and ${props.r.session.length === 'full' ? 'about a minute and a half' : 'about a minute'} of you talking. This round ended sooner.`}
      </p>
      <a class="btn btn-primary" href={again} data-test="no-signal-again">
        {props.meeting ? 'Rehearse it again' : 'Try the round again'}
      </a>
    </div>
  );
}

function Weakest(props: { r: ReportData }) {
  const w = props.r.weakest_moment!;
  return (
    <div class="weakest" data-test="weakest">
      <p class="weakest-q">
        <span class="stamp num">{clock(w.t_start_sec)}</span> “{w.question}”
      </p>
      <p>{w.what_happened}</p>
      <div class="weakest-grid">
        <div>
          <h3>A strong answer covers</h3>
          <ul class="checks">
            {w.strong_answer_covers.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>A short model answer</h3>
          <p class="model">{w.model_answer}</p>
        </div>
      </div>
      {w.retries && w.retries.length > 0 && (
        <ul class="retries" data-test="retries">
          {w.retries.map((x) => (
            <li key={x.session_id}>
              <span class="retry-scores num">
                {x.before_score ?? '?'} <span aria-hidden="true">→</span>
                <span class="sr-only">to</span> {x.after_score ?? '?'}
              </span>
              <span>{x.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PACE: Record<string, string> = { slow: 'A bit slow', good: 'Good pace', fast: 'A bit fast' };
const FILLER: Record<string, string> = { good: 'Rare', okay: 'Some', work_on_it: 'Work on it' };

function DeliveryStrip(props: { d: Delivery; meeting: boolean }) {
  const d = props.d;
  const cells: { k: string; label: string; value: string; note?: string; tone?: 'good' | 'warn' }[] = [];
  if (d.wpm != null)
    cells.push({ k: 'pace', label: 'Pace', value: `${Math.round(d.wpm)} wpm`, note: d.wpm_band ? PACE[d.wpm_band] : undefined, tone: d.wpm_band === 'good' ? 'good' : 'warn' });
  if (d.filler_per_min != null) {
    const top = (d.filler_top ?? []).filter((f) => f.word).slice(0, 2).map((f) => `“${f.word}” ${f.count ?? ''}`.trim());
    cells.push({
      k: 'fillers',
      label: 'Filler words',
      value: `${d.filler_per_min.toFixed(1)} a min`,
      note: [d.filler_band ? FILLER[d.filler_band] : null, top.length ? top.join(', ') : null].filter(Boolean).join('. '),
      tone: d.filler_band === 'good' ? 'good' : 'warn',
    });
  }
  if (d.long_pauses)
    cells.push({
      k: 'pauses',
      label: 'Long pauses',
      value: String(d.long_pauses.length),
      note: d.long_pauses[0]?.t_sec != null ? `First at ${clock(d.long_pauses[0].t_sec)}` : 'None inside an answer',
      tone: d.long_pauses.length <= 1 ? 'good' : 'warn',
    });
  if (d.talk_ratio_user != null)
    cells.push({ k: 'talk', label: 'You talked', value: pct(d.talk_ratio_user)!, note: props.meeting ? 'Of the meeting' : 'Of the round' });
  if (d.gaze_on_speaker_pct != null)
    cells.push({
      k: 'gaze',
      label: 'Facing who spoke',
      value: pct(d.gaze_on_speaker_pct)!,
      note: 'From head direction',
      tone: d.gaze_on_speaker_pct >= 0.6 ? 'good' : 'warn',
    });
  if (d.user_interruptions != null) cells.push({ k: 'interrupts', label: 'Interruptions', value: String(d.user_interruptions) });
  if (d.hints && d.hints.length > 0) cells.push({ k: 'hints', label: 'Hints used', value: String(d.hints.length) });

  if (cells.length === 0) return <p class="muted" data-test="delivery-empty">No timing was recorded for this round.</p>;
  return (
    <dl class="strip" data-test="delivery">
      {cells.map((c) => (
        <div class={`strip-cell${c.tone ? ` tone-${c.tone}` : ''}`} key={c.k} data-test={`delivery-${c.k}`}>
          <dt>{c.label}</dt>
          <dd>
            <span class="strip-value num">{c.value}</span>
            {c.note && <span class="strip-note">{c.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const STANCE = ['Against', 'Doubtful', 'Neutral', 'Open', 'For you'];
const stanceName = (s: number | undefined) => (s == null ? null : STANCE[Math.max(0, Math.min(4, Math.round(s) + 2))]);
const HANDLED: Record<string, string> = { well: 'Handled well', partly: 'Partly handled', poorly: 'Handled poorly', not_addressed: 'Not addressed' };

function Room(props: { m: MeetingDetails }) {
  const m = props.m;
  return (
    <div class="room" data-test="room">
      {m.attendees && m.attendees.length > 0 && (
        <ul class="people">
          {m.attendees.map((a) => (
            <li key={a.name}>
              <p class="person-head">
                <span>
                  <strong>{a.name}</strong>
                  {a.role && <span class="muted">, {a.role}</span>}
                </span>
              </p>
              {a.stance_start != null && a.stance_end != null && (
                <p class="stance" data-test="stance">
                  {stanceName(a.stance_start)} <span aria-hidden="true">→</span>
                  <span class="sr-only">to</span> <strong>{stanceName(a.stance_end)}</strong>
                </p>
              )}
              {a.one_line && <p class="person-says">“{a.one_line}”</p>}
            </li>
          ))}
        </ul>
      )}
      {m.objections && m.objections.length > 0 && (
        <>
          <h3>Objections</h3>
          <ul class="objections">
            {m.objections.map((o, i) => (
              <li key={i}>
                <p>
                  {o.by && <strong>{o.by}: </strong>}“{o.objection}”{' '}
                  {o.handled && <span class={`tag tag-${o.handled}`}>{HANDLED[o.handled]}</span>}
                </p>
                {o.better_response && <p class="fine">Better: {o.better_response}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      {m.next_steps && m.next_steps.length > 0 && (
        <>
          <h3>Next steps agreed</h3>
          <ul class="steps-agreed">
            {m.next_steps.map((s, i) => (
              <li key={i}>
                <strong>{s.owner}</strong> {s.action}
                {s.due && <span class="muted">, by {s.due}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * The final board in words, one part per line ("Components: ...", "Links: ..."): a short list, the part's name
 * set apart from what was on the board.
 */
function BoardText(props: { text: string }) {
  const parts = props.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([A-Z][A-Za-z ]{1,30}): (.+)$/.exec(l);
      return m ? { name: m[1]!, text: m[2]! } : { name: null, text: l };
    });
  return (
    <ul class="board-text" data-test="board-text">
      {parts.map((p, i) => (
        <li key={i}>
          {p.name && <span class="board-part">{p.name}</span>}
          <span>{p.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Transcript(props: { r: ReportData; catalog?: Catalog; player: Player | null }) {
  const lines = transcriptOf(props.r);
  const name = (s: string) => (s === 'user' ? 'You' : persona(props.catalog, s)?.display_name ?? s.replace(/^persona\./, ''));
  const moments: Line[] =
    lines ??
    [...props.r.evidence]
      .sort((a: Evidence, b: Evidence) => a.t_start_sec - b.t_start_sec)
      .map((e) => ({ t: e.t_start_sec, speaker: e.speaker, text: e.quote }));
  return (
    <Disclosure test="transcript" summary={lines ? 'Show the transcript' : 'Show the quoted moments in order'}>
      <ol class="transcript">
        {moments.map((l, i) => (
          <li key={i} class={l.speaker === 'user' ? 'you' : ''}>
            {props.player ? (
              <button type="button" class="stamp play" onClick={() => props.player!.play(l.t)} aria-label={`Play from ${clock(l.t)}`}>
                {clock(l.t)}
              </button>
            ) : (
              <span class="stamp num">{clock(l.t)}</span>
            )}
            <span class="who-said">{name(l.speaker)}</span>
            <span class="said">{l.text}</span>
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}

function Share(props: { r: ReportData }) {
  const initial = props.r.share?.public_slug ?? null;
  const [slug, setSlug] = useState<string | null>(initial);
  const [url, setUrl] = useState<string | null>(initial ? `${location.origin}/s/${initial}` : null);
  // A live link keeps showing what it shares.
  const [withTranscript, setWithTranscript] = useState(!!initial && !!props.r.share?.include_quotes);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<'no' | 'yes' | 'manual'>('no');

  // A new link: "Copied" belonged to the old one.
  useEffect(() => setCopied('no'), [slug]);

  const create = async (transcript: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createShare(props.r.session.id, transcript);
      setSlug(res.slug);
      setUrl(res.url);
    } catch (e) {
      setErr(toApiError(e).status === 0 ? 'No connection. Try again.' : 'Could not make the link. Try again.');
    } finally {
      setBusy(false);
    }
  };
  /** Changing what a live link shares: take the old link down first, so only one stays public. */
  const change = async (transcript: boolean) => {
    const was = withTranscript;
    setWithTranscript(transcript);
    if (!slug) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteShare(slug);
    } catch {
      // The old link is still live and still shares the old choice: show that.
      setWithTranscript(was);
      setErr('Could not change the link. It still shares what it did. Try again.');
      setBusy(false);
      return;
    }
    setSlug(null);
    setUrl(null);
    await create(transcript);
  };
  const remove = async () => {
    if (!slug) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteShare(slug);
      setSlug(null);
      setUrl(null);
    } catch {
      setErr('Could not turn the link off. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const on = !!slug;
  return (
    <div class="share" data-test="share">
      <div class="share-row">
        <div>
          <p class="share-title" id="share-label">
            Public scorecard link
          </p>
          <p class="fine">Verdict, scores and highlights. Off any time.</p>
          {props.r.session.mode === 'meeting' && (
            <p class="fine" data-test="share-names-note">
              It may name the people in your meeting.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          class="switch"
          aria-checked={on}
          aria-labelledby="share-label"
          disabled={busy}
          onClick={() => void (on ? remove() : create(withTranscript))}
          data-test="share-toggle"
        >
          <span class="switch-knob" />
        </button>
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={withTranscript}
          disabled={busy}
          onChange={(e) => void change(e.currentTarget.checked)}
          data-test="share-transcript"
        />
        <span>Include the transcript and quotes</span>
      </label>
      {err && (
        <p class="bad" role="alert">
          {err}
        </p>
      )}
      {on && url && (
        <div class="share-link" data-test="share-link">
          <input type="text" readOnly value={url} aria-label="Scorecard link" onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            class="btn btn-small"
            onClick={(e) => {
              const input = (e.currentTarget.parentElement?.querySelector('input') ?? null) as HTMLInputElement | null;
              const fallback = () => {
                input?.focus();
                input?.select();
                setCopied('manual');
              };
              if (!navigator.clipboard) return fallback();
              navigator.clipboard.writeText(url).then(() => setCopied('yes'), fallback);
            }}
            data-test="share-copy"
          >
            {copied === 'yes' ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      {on && copied === 'manual' && (
        <p class="fine" role="status" data-test="share-copy-manual">
          Copying is blocked here. The link is selected: copy it from the box.
        </p>
      )}
    </div>
  );
}

/** The top of the report in one look: the best thing, the one fix, and the next step. */
function Highlights(props: { r: ReportData; meeting: boolean }) {
  const { r, meeting } = props;
  const good = r.strengths[0];
  const fix = r.weaknesses[0];
  const retry = canRetry(r);
  const again = meeting ? '/meeting/new' : r.session.round_id ? `/round/${r.session.round_id}` : '/start';
  if (!good && !fix && !retry) return null;
  return (
    <div class="highlights" data-test="highlights">
      {(good || fix) && (
        <div class="hl-pair">
          {good && (
            <div class="hl hl-good" data-test="top-strength">
              <p class="hl-label">
                <span aria-hidden="true">✓</span> Keep doing
              </p>
              <p class="hl-title">{good.title}</p>
              <p class="hl-detail">{good.detail}</p>
            </div>
          )}
          {fix && (
            <div class="hl hl-fix" data-test="top-fix">
              <p class="hl-label">
                <span aria-hidden="true">↗</span> Work on next
              </p>
              <p class="hl-title">{fix.title}</p>
              <p class="hl-detail">{fix.detail}</p>
            </div>
          )}
        </div>
      )}
      <div class="row hl-next">
        {retry ? (
          <>
            <a class="btn btn-primary btn-big" href={retryHref(r)} data-test="retry-answer">
              Retry your weakest answer
            </a>
            <span class="fine">About {Math.round((r.weakest_moment?.retry?.max_seconds ?? 120) / 60)} min, scored again.</span>
          </>
        ) : (
          <a class="btn btn-primary" href={again} data-test="go-again">
            {meeting ? 'Rehearse it again' : 'Practice again'}
          </a>
        )}
      </div>
    </div>
  );
}

/** Why each competency got its score: one line each, folded under the bars. */
function Reasons(props: { r: ReportData }) {
  const rows = props.r.competencies.filter((c) => c.rationale && c.score != null);
  if (rows.length === 0) return null;
  return (
    <Disclosure test="bar-reasons" summary="Why these scores">
      <ul class="reasons">
        {rows.map((c) => (
          <li key={c.id}>
            <strong>{c.name}.</strong> {c.rationale}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

// ---------- Page ----------

function ReportBody(props: { r: ReportData }) {
  const r = props.r;
  const catalog = useAsync(() => loadCatalog(), []);
  const [player, audioEl] = usePlayer(recordingUrl(r));
  const meeting = r.session.mode === 'meeting';
  const details = r.round_details;
  const md = details?.kind === 'meeting' ? details : null;
  const title = catalog.data?.rounds.find((x) => x.id === r.session.round_id)?.title ?? (meeting ? 'Meeting rehearsal' : 'Your round');
  const mins = Math.max(1, Math.round(r.session.duration_sec / 60));
  const board = details && (details.kind === 'system_design' || details.kind === 'object_design') ? details : null;

  const facts = [
    r.session.started_at ? longDate(r.session.started_at) : null,
    plural(mins, 'minute'),
    r.session.seniority !== 'n/a' ? `${LEVEL_NAMES[r.session.seniority]} level` : null,
    r.session.length === 'short' ? 'quick round' : 'full round',
  ].filter(Boolean);

  return (
    <Page test="report" title={title} lede={facts.join(', ')} back={{ href: '/history', label: 'History' }} wide attrs={{ 'data-mode': r.session.mode }}>
      {audioEl}
      <div class="report">
        <Section name="verdict" title={meeting ? 'Outcome' : 'Verdict'} hideTitle>
          {md ? (
            <MeetingOutcome details={md} summary={r.headline.summary} overall={r.headline.overall_score} />
          ) : r.headline.verdict ? (
            <Verdict verdict={r.headline.verdict} summary={r.headline.summary} />
          ) : (
            <NoSignal r={r} meeting={meeting} />
          )}
        </Section>

        {r.competencies.length > 0 && (
          <Section
            name="competencies"
            title={meeting ? 'How you ran it' : 'Competencies'}
            lede={meeting ? '1 to 4. 3 is a solid meeting.' : '1 to 4. 3 meets the bar for your level.'}
          >
            <Bars competencies={r.competencies} compact />
            <Reasons r={r} />
          </Section>
        )}

        {r.headline.verdict || md ? (
          <Section name="highlights" title="In short" hideTitle>
            <Highlights r={r} meeting={meeting} />
          </Section>
        ) : null}

        {md && (md.attendees?.length || md.objections?.length || md.next_steps?.length) ? (
          <Section name="room" title="The room" fold>
            <Room m={md} />
          </Section>
        ) : null}

        {r.strengths.length > 0 && (
          <Section name="strengths" title="What went well" fold count={r.strengths.length}>
            <ul class="points">
              {r.strengths.map((p) => (
                <QuoteRow key={p.title} point={p} evidence={r.evidence} tone="good" player={player} />
              ))}
            </ul>
          </Section>
        )}

        {r.weaknesses.length > 0 && (
          <Section name="weaknesses" title="What to work on" fold count={r.weaknesses.length}>
            <ul class="points">
              {r.weaknesses.map((p) => (
                <QuoteRow key={p.title} point={p} evidence={r.evidence} tone="bad" player={player} />
              ))}
            </ul>
          </Section>
        )}

        {r.weakest_moment && (
          <Section name="weakest" title="Your weakest moment" fold>
            <Weakest r={r} />
          </Section>
        )}

        {r.next_drills.length > 0 && (
          <Section name="drills" title="Practice next" fold count={r.next_drills.length}>
            <ul class="drills">
              {r.next_drills.map((d) => {
                const href = drillHref(d, r);
                const inner = (
                  <>
                    <span class="drill-title">{d.title}</span>
                    <span class="drill-why">{d.why}</span>
                    <span class="drill-min num">{d.est_minutes} min</span>
                  </>
                );
                return (
                  <li key={d.title}>
                    {href ? (
                      <a class="drill" href={href} data-test="drill">
                        {inner}
                      </a>
                    ) : (
                      <div class="drill drill-static" data-test="drill">
                        {inner}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <Section name="delivery" title="How you sounded" fold>
          <DeliveryStrip d={r.delivery} meeting={meeting} />
        </Section>

        <Section name="transcript" title={board ? 'Transcript and board' : 'Transcript'}>
          <Transcript r={r} catalog={catalog.data} player={player} />
          {board?.board_image_url || board?.board_as_text ? (
            <Disclosure test="board" summary="Show the board">
              {board.board_image_url ? (
                <figure class="board" data-test="board-image">
                  <img src={board.board_image_url} alt="Your board at the end of the round" loading="lazy" />
                </figure>
              ) : (
                <BoardText text={board.board_as_text!} />
              )}
            </Disclosure>
          ) : null}
        </Section>

        <Section name="share" title="Share">
          <Share r={r} />
        </Section>
      </div>
    </Page>
  );
}

const STAGES = ['Measuring how you sounded', 'Scoring each answer', 'Writing your report'];

function Waiting(props: { since: number; status: SessionStatus }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (props.status !== 'scoring' && props.status !== 'scored') {
    return (
      <Page test="report" title="This round is still going" lede="The report is written when the round ends." back={{ href: '/history', label: 'History' }}>
        <div class="state" data-test="report-not-ended">
          <p>Finish the round in your headset or on the round screen, then come back here.</p>
          <a class="btn" href="/">
            Go home
          </a>
        </div>
      </Page>
    );
  }
  const elapsed = now - props.since;
  // An honest estimate: moves steadily, slows near the end, never claims done.
  const est = Math.min(0.92, 1 - Math.exp(-elapsed / (EXPECTED_SCORING_MS / 2)));
  const stage = Math.min(STAGES.length - 1, Math.floor(est * STAGES.length));
  return (
    <Page test="report" title="Writing your scorecard" lede="Usually about half a minute." back={{ href: '/history', label: 'History' }}>
      <div class="scoring" data-test="report-scoring">
        <div class="progress" role="progressbar" aria-label="Scoring progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(est * 100)}>
          <span style={{ width: `${Math.round(est * 100)}%` }} />
        </div>
        <ol class="stages">
          {STAGES.map((s, i) => (
            <li key={s} class={i < stage ? 'done' : i === stage ? 'now' : ''} aria-current={i === stage ? 'step' : undefined}>
              {s}
            </li>
          ))}
        </ol>
        {elapsed > SLOW_SCORING_MS && (
          <p class="note" role="status" data-test="report-slow">
            Taking longer than usual. You can leave: it will be in your{' '}
            <a href="/history">History</a> when it is ready.
          </p>
        )}
      </div>
    </Page>
  );
}

/** Keeps a malformed report from blanking the page: a calm message and another try. */
class ReportBoundary extends Component<{ onRetry: () => void; children: ComponentChildren }, { broken: boolean }> {
  override state = { broken: false };
  static override getDerivedStateFromError() {
    return { broken: true };
  }
  override componentDidCatch(err: unknown) {
    console.error('report render failed', err);
  }
  override render() {
    if (!this.state.broken) return this.props.children;
    return (
      <Page test="report" title="We couldn't show this report" back={{ href: '/history', label: 'History' }}>
        <div class="state" role="alert" data-test="report-broken">
          <p>Something in this report did not display. Your other reports are fine.</p>
          <div class="row">
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => {
                this.setState({ broken: false });
                this.props.onRetry();
              }}
              data-test="report-broken-retry"
            >
              Try again
            </button>
            <a class="btn" href="/history">
              Your history
            </a>
          </div>
        </div>
      </Page>
    );
  }
}

/**
 * Scoring gave up (the model was down, or its answers were broken twice): one tap scores it again. At the daily
 * limit the button stays off with the server's message; a report scored meanwhile (409) is simply loaded.
 */
function Failed(props: { id: string; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [limited, setLimited] = useState(false);
  const retry = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.rescore(props.id);
      props.onRetried();
    } catch (e) {
      const a = toApiError(e);
      if (a.status === 409) {
        // Scored meanwhile (another tab, a late attempt): show it.
        props.onRetried();
        return;
      }
      if (a.code === 'rescore_limit') setLimited(true);
      setErr(a.code === 'rescore_limit' ? a.message : a.status === 0 ? 'No connection. Try again.' : 'Could not start it again. Try again in a minute.');
      setBusy(false);
    }
  };
  return (
    <Page test="report" title="We could not score this round" back={{ href: '/history', label: 'History' }}>
      <div class="state" data-test="report-failed">
        <p>Something went wrong while writing the scorecard. Your other reports are fine.</p>
        {err && (
          <p class="note" role="alert" data-test="report-retry-error">
            {err}
          </p>
        )}
        <div class="row">
          <button type="button" class="btn btn-primary" disabled={busy || limited} onClick={() => void retry()} data-test="report-retry">
            {busy ? 'Starting…' : 'Try again'}
          </button>
          <a class="btn" href="/history">
            Your history
          </a>
        </div>
      </div>
    </Page>
  );
}

export function Report(props: { id?: string }) {
  const id = props.id ?? '';
  const [view, reload] = useReport(id);
  const { route } = useLocation();
  // A retry answers with its parent's report (with the before and after on it): show it at the parent's address.
  const parentId = view.kind === 'ready' && view.report.session.id && view.report.session.id !== id ? view.report.session.id : null;
  useEffect(() => {
    if (!parentId || view.kind !== 'ready') return;
    handoff = view.report;
    route(`/report/${encodeURIComponent(parentId)}`, true);
  }, [parentId]);
  if (view.kind === 'ready') {
    return (
      <ReportBoundary onRetry={reload}>
        <ReportBody r={view.report} />
      </ReportBoundary>
    );
  }
  if (view.kind === 'waiting') return <Waiting since={view.since} status={view.status} />;
  if (view.kind === 'failed') return <Failed id={id} onRetried={reload} />;
  if (view.kind === 'abandoned') {
    return (
      <Page test="report" title="This round was not scored" back={{ href: '/history', label: 'History' }}>
        <div class="state" data-test="report-abandoned">
          <p>It ended before there was anything to score.</p>
          <div class="row">
            <a class="btn btn-primary" href="/start">
              Start a new round
            </a>
            <a class="btn" href="/history">
              Your history
            </a>
          </div>
        </div>
      </Page>
    );
  }
  return (
    <Page test="report" title="Your report" back={{ href: '/history', label: 'History' }}>
      {view.kind === 'loading' && <Loading rows={5} />}
      {view.kind === 'error' && (
        <ErrorState error={view.error} onRetry={reload}>
          <a class="btn btn-quiet" href="/history">
            Your history
          </a>
        </ErrorState>
      )}
    </Page>
  );
}
