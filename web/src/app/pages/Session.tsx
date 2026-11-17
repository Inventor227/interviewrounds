// The live round page. On a headset the round runs in the room and this page is what the user
// comes back to: its state, the way back in if they left the headset view, and the way on to the
// report. Without a headset it shows the preview room on screen, with the sheet to draw on by
// mouse in rounds that have one.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { DevConsole } from '../../session/DevConsole';
import { isDebug } from '../../session/browser';
import { NOTICES } from '../../session/notices';
import type { ControllerState } from '../../session/ports';
import { liveRoom, type LiveRoom } from '../../session/room';
import type { StageSpans } from '../../session/timings';
import type { ImmersiveHandle } from '../../xr/entry';
import { loadMe } from '../components/data';
import { clock } from '../components/format';
import { Page } from '../components/Ui';
import { recordController, recorder } from '../../session/recorder';
import { takeLaunch } from '../launch';
import { useNow } from './Home';


type Taken = NonNullable<ReturnType<typeof takeLaunch>>;

/** What the page says for each state of the round: a few words in a status pill. */
export const STATE_LINE: Record<ControllerState, string> = {
  idle: 'Getting the room ready',
  placing: 'Touch your desk to place the sheet',
  greeting: 'Your interviewer is saying hello',
  live: 'Live',
  paused: 'Paused',
  ending: 'Wrapping up',
  scoring: 'Writing your scorecard',
  summary: 'Your scorecard is ready',
  failed: 'The round could not start',
};

/** A card of the room as one line of the page: title, then detail. */
export function noticeLine(n: { title: string; detail: string }): string {
  if (!n.detail) return n.title;
  return /[.!?…]$/.test(n.title) ? `${n.title} ${n.detail}` : `${n.title}. ${n.detail}`;
}

/** Errors that end the round on this page; the rest show in the room or pass by themselves. */
const FATAL = new Set(['connect_failed', 'session_expired', 'no_credit', 'socket_terminal', 'room_load_failed']);

/** How often the page asks the server how long a held round can still be resumed. */
export const RESUMABLE_POLL_MS = 30_000;

/**
 * The round is held while the user is out of the headset view. How long is the server's to say
 * (`me.resumable.expires_at`: the end of the pause budget), read when the offer shows, when the
 * page comes back into view and every 30 s. The page never ends the round by itself: without a
 * deadline it shows none, and the server's own end arrives over the room socket.
 */
function ResumeOffer(props: { sessionId: string; onResume: () => void; onEnd: () => void }) {
  const now = useNow();
  const [deadline, setDeadline] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      loadMe(true)
        .then((me) => {
          const r = me.resumable;
          if (live) setDeadline(r && r.session_id === props.sessionId ? Date.parse(r.expires_at) : null);
        })
        .catch(() => undefined);
    void read();
    const t = setInterval(read, RESUMABLE_POLL_MS);
    const onVis = () => document.visibilityState === 'visible' && void read();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [props.sessionId]);
  const left = deadline === null ? null : Math.max(0, (deadline - now) / 1000);
  return (
    <div class="state" role="region" aria-label="Resume your round" data-test="resume-offer">
      <h2>Your round is paused</h2>
      <p>
        Your interviewer is waiting.
        {left !== null && left > 0 && (
          <>
            {' '}
            You have <span class="num" data-test="resume-left">{clock(left)}</span> to come back.
          </>
        )}
      </p>
      <div class="row">
        <button class="btn btn-primary btn-big" data-test="resume-round" onClick={props.onResume}>
          Resume round
        </button>
        <button class="btn" data-test="end-from-page" onClick={props.onEnd}>
          End the round
        </button>
      </div>
    </div>
  );
}

/** A stage this narrow is a phone: the room's own End is too small to hold by touch there. */
export const NARROW_STAGE_QUERY = '(max-width: 720px)';
/** How long the page's "End the round?" stays up before it goes back to a plain End. */
export const END_CONFIRM_MS = 5000;

function useNarrow(): boolean {
  const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_STAGE_QUERY) : null;
  const [narrow, setNarrow] = useState(() => !!mq?.matches);
  useEffect(() => {
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

/**
 * End on the page, for the preview on a phone. Two taps (End, then End round), like the room's hold, so a stray tap
 * never ends the round; the question goes away by itself after a few seconds.
 */
function PageEnd(props: { onEnd: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), END_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [asking]);
  if (!asking) {
    return (
      <div class="row">
        <button class="btn btn-small" data-test="page-end" onClick={() => setAsking(true)}>
          End
        </button>
      </div>
    );
  }
  return (
    <div class="row" role="group" aria-label="End the round?">
      <span class="meta">End the round?</span>
      <button class="btn btn-small btn-primary" data-test="page-end-confirm" onClick={() => { setAsking(false); props.onEnd(); }}>
        End round
      </button>
      <button class="btn btn-small btn-quiet" data-test="page-end-cancel" onClick={() => setAsking(false)}>
        Keep going
      </button>
    </div>
  );
}

const SPAN_LABELS: [keyof StageSpans, string][] = [
  ['session_ms', 'Session'],
  ['chunk_ms', 'Room code'],
  ['avatars_ms', 'People'],
  ['prepare_ms', 'Ready for Enter'],
  ['xr_start_ms', 'Headset start'],
  ['placement_ms', 'Desk placement'],
  ['voice_connect_ms', 'Voice connect'],
  ['first_audio_ms', 'Start to first word'],
  ['enter_to_first_word_ms', 'Enter to first word, less placement'],
  ['enter_to_first_word_wall_ms', 'Enter to first word'],
];

function Timings(props: { room: LiveRoom }) {
  const [spans, setSpans] = useState(() => props.room.timings.spans());
  useEffect(() => props.room.timings.onChange(setSpans), [props.room]);
  return (
    <table class="meta" data-test="stage-timings" style={{ position: 'fixed', right: '16px', bottom: '16px', zIndex: 1000, background: 'var(--glass)', color: 'var(--glass-ink)', padding: '8px', borderRadius: '8px', font: '12px/1.4 ui-monospace, Menlo, monospace' }}>
      <tbody>
        {SPAN_LABELS.map(([k, label]) => (
          <tr key={k}>
            <td>{label}</td>
            <td align="right" data-span={k}>
              {spans[k] === null ? 'n/a' : `${spans[k]} ms`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Moves the room's canvas element into the page while it is shown, and back out after. */
function useStage(room: LiveRoom | null, show: boolean) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!room || !show || !el) return;
    const host = room.host;
    const before = host.style.cssText;
    const home = host.parentElement;
    host.style.cssText = 'position:relative;width:100%;height:100%;';
    el.append(host);
    return () => {
      host.style.cssText = before;
      if (home && host.isConnected) home.append(host);
    };
  }, [room, show]);
  return stage;
}

function BoardCanvas(props: { room: LiveRoom }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !props.room.attachBoardCanvas) return;
    return props.room.attachBoardCanvas(c);
  }, [props.room]);
  return (
    <section class="session-board" aria-labelledby="sheet-title" data-test="session-board">
      <h2 id="sheet-title" class="sr-only">Your sheet</h2>
      <ul class="sheet-hints" aria-label="How to draw">
        <li>
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <rect x="3" y="5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
          </svg>
          Drag to draw a box
        </li>
        <li>
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <rect x="2" y="4" width="10" height="5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M12 6.5h4v9M13.5 13l2.5 2.5 2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Or pull a card from the tray
        </li>
        <li>
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
            <circle cx="4.5" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <circle cx="15.5" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M7 10h6" stroke="currentColor" stroke-width="1.8" />
          </svg>
          Draw a line between cards to link them
        </li>
      </ul>
      <div class="session-board-stage">
        <canvas ref={canvas} style={{ display: 'block', touchAction: 'none' }} />
      </div>
    </section>
  );
}

/** Where "Try again" goes after a round that never began: the same start it came from. */
export function startHref(launch: Pick<Taken, 'input' | 'session'>): string {
  const { input, session } = launch;
  if (input.kind === 'resume') return `/resume/${encodeURIComponent(input.sessionId)}`;
  if (input.kind === 'retry') return `/round/${encodeURIComponent(session.round.id)}?retry=${encodeURIComponent(input.parentSessionId)}`;
  return input.req.mode === 'meeting' ? '/meeting/new' : `/round/${encodeURIComponent(session.round.id)}`;
}

function LiveSession(props: { launch: Taken }) {
  const { controller, preview } = props.launch;
  const { route } = useLocation();
  const [room] = useState(liveRoom);
  const [state, setState] = useState(controller.state);
  // The session can be made again before the voices join (a voice token that ran out): links follow it.
  const [session, setSession] = useState(props.launch.session);
  const [error, setError] = useState<{ code: string } | null>(null);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState(controller.notice ?? null);
  // Whether the interviewer ever spoke: a failure before that is a round that never began.
  const [began, setBegan] = useState(controller.state === 'live');
  const [, bump] = useState(0);
  const debug = isDebug();
  const dev = import.meta.env.DEV;
  const fakeVoice = session.panel.some((p) => p.voice.transport === 'fake');

  useEffect(() => {
    const current = () => controller.session ?? props.launch.session;
    // The round may have moved on between the Enter tap and this page listening.
    setState(controller.state);
    if (controller.state === 'live') setBegan(true);
    const offs = [
      controller.on('state', (s) => {
        // The round runs again after a pause: what its old voices reported meanwhile is over.
        if (s === 'live' || s === 'greeting') setError(null);
        setState(s);
        if (s === 'live') setBegan(true);
      }),
      controller.on('session', setSession),
      controller.on('notice', setNotice),
      controller.on('error', (e) => {
        // The user ended the round before it began: nothing to show, back home.
        if ((e as { code: string }).code === 'cancelled') route('/');
        else setError(e as { code: string });
      }),
      // The room's own buttons: leaving this page ends the headset session and frees the room.
      controller.on('action', (a) => {
        const sid = encodeURIComponent(current().session_id);
        route(a === 'history' ? '/history' : a === 'report' ? `/report/${sid}` : `/round/${encodeURIComponent(current().round.id)}?retry=${sid}`);
      }),
      room?.onChange(() => bump((n) => n + 1)) ?? (() => undefined),
    ];
    if (dev) (globalThis as { __round?: unknown }).__round = { controller, room, get session() { return current(); }, timings: () => room?.timings.spans() };
    // Development only: the production build drops the recorder and everything it pulls in.
    const rec = import.meta.env.DEV ? recorder() : null;
    if (rec) offs.push(recordController(rec, controller));
    return () => {
      offs.forEach((o) => o());
      if (dev) delete (globalThis as { __round?: unknown }).__round;
      void controller.dispose();
    };
  }, [controller]);

  // The canvas shows on the page in the preview; in the headset only tooling needs to see it.
  const stage = useStage(room, preview || dev);
  const sid = encodeURIComponent(session.session_id);
  const over = state === 'scoring' || state === 'summary';
  const narrow = useNarrow();
  // The room's End is a small target on a phone: the page offers its own while the round runs.
  const pageEnd = preview && narrow && (state === 'greeting' || state === 'live' || state === 'paused');
  const lost = !!room?.sessionLost && !over && !preview && state !== 'failed' && state !== 'ending';
  // Before the round began there is nothing to resume: the way back is the start itself.
  const lostBefore = lost && (state === 'idle' || state === 'placing');
  const lostPaused = lost && !lostBefore;
  // Said while the report is being written; once it is ready the summary line takes over.
  const endedPaused = (state === 'scoring' || state === 'ending') && controller.endedWhilePaused;
  // In the preview the cards of the room are on the canvas; the page says the same in words.
  const card = preview && notice && !over ? NOTICES[notice] : null;
  const retryEnter = !lost && state !== 'failed' && (error?.code === 'xr_enter_failed' || error?.code === 'placement_failed');
  // A held round is not lost, whatever its voices reported meanwhile: the room offers Resume.
  const failed = !over && (state === 'failed' || (!!error && FATAL.has(error.code) && state !== 'paused'));
  // Before the first word there is no round to lose and no report to see: offer the start again.
  const neverBegan = failed && !began;
  const lostRound = failed && began;
  const lede = preview ? 'A preview on your screen. On a Quest, the room is at your desk.' : 'Your round is in the headset.';
  const back = (tap: () => Promise<void>) => {
    setNote('');
    setError(null);
    tap().catch(() => setNote('The headset did not start the room. Tap again.'));
  };

  return (
    <Page test="session" title={props.launch.title ?? session.round.title ?? 'Live round'} lede={lede} wide={preview}>
      {!failed && !lostPaused && !endedPaused && (
        <p class={`state-pill${state === 'live' && !card ? ' is-live' : ''}`} role="status" data-test="session-state" data-state={state}>
          <span class="state-dot" aria-hidden="true" />
          {card ? noticeLine(card) : STATE_LINE[state]}
        </p>
      )}
      {endedPaused && (
        <p class="note" role="status" data-test="ended-paused" data-state={state}>
          The round ended while paused. Writing your report.
        </p>
      )}
      {retryEnter && (
        <div class="row">
          <button class="btn btn-primary btn-big" data-test="enter-room" onClick={() => back(() => controller.enter())}>
            Enter the room
          </button>
        </div>
      )}
      {lostBefore && (
        <div class="row">
          {/* Through the controller: before the round began this is the start itself. */}
          <button class="btn btn-primary btn-big" data-test="return-to-room" onClick={() => back(() => controller.returnToRoom())}>
            Return to the room
          </button>
          <button class="btn" data-test="end-from-page" onClick={() => controller.end()}>
            End the round
          </button>
        </div>
      )}
      {lostPaused && (
        // The headset view is gone but the round is held: one tap goes back in, places the desk and carries on.
        <ResumeOffer
          sessionId={session.session_id}
          onResume={() => back(() => controller.returnToRoom())}
          onEnd={() => controller.end()}
        />
      )}
      {(over || (endedPaused && state === 'ending')) && (
        <div class="row">
          <a class="btn btn-primary" data-test="see-report" href={`/report/${sid}`}>
            {endedPaused ? 'See report' : 'See full report'}
          </a>
        </div>
      )}
      {neverBegan && (
        <div class="state state-error" role="alert" data-test="session-not-started" data-code={error?.code}>
          <h2>Couldn't start the round</h2>
          <p>
            Your interviewer did not join. {controller.started ? 'Try again.' : 'Nothing was used up. Try again.'}
          </p>
          <div class="row">
            <a class="btn btn-primary" href={startHref({ input: props.launch.input, session })} data-test="try-again">
              Try again
            </a>
            <a class="btn" href="/">
              Go home
            </a>
          </div>
        </div>
      )}
      {lostRound && (
        <div class="state state-error" role="alert" data-test="session-error" data-code={error?.code}>
          <h2>We lost the round</h2>
          <p>The connection dropped. What you said is saved.</p>
          <div class="row">
            <a class="btn btn-primary" href={`/report/${sid}`}>
              See the report
            </a>
            <a class="btn" href="/">
              Go home
            </a>
          </div>
        </div>
      )}
      {note && <p class="meta bad">{note}</p>}
      {(preview || dev) && <div class="xr-stage" ref={stage} data-test="session-stage" />}
      {pageEnd && <PageEnd onEnd={() => controller.end()} />}
      {preview && room?.hasBoard && room.attachBoardCanvas && <BoardCanvas room={room} />}
      {/* Typed turns: with ?debug=1, and in a development preview with the typed-turn voice. */}
      {(debug || (dev && fakeVoice && preview)) && <DevConsole source={controller} />}
      {debug && room && <Timings room={room} />}
    </Page>
  );
}

/** Without a round (a reloaded or shared link): the bare room, as a look around. */
function BareRoom(props: { id?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<ImmersiveHandle | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!stage.current) return;
    let live = true;
    let h: ImmersiveHandle | null = null;
    import('../../xr/entry')
      .then((m) => m.createImmersive(stage.current as HTMLElement))
      .then((created) => {
        h = created;
        if (live) setHandle(created);
        else created.destroy();
      })
      .catch(() => live && setNote('The room could not load on this device.'));
    return () => {
      live = false;
      h?.destroy();
    };
  }, []);

  return (
    <Page test="session" title="Live round" lede="This round is not running here. Start one from home, or look around.">
      <p class="meta">
        Session <code>{props.id}</code>
      </p>
      <div class="row">
        <a class="btn btn-primary" href="/">
          Go home
        </a>
        {handle?.mode !== 'preview' && (
          <button
            class="btn"
            data-test="enter-room"
            disabled={!handle}
            onClick={() => {
              setNote('');
              handle?.enter().catch((e: Error) => setNote(e.message));
            }}
          >
            Look around the room
          </button>
        )}
      </div>
      {handle?.mode === 'preview' && (
        <p class="meta" data-test="preview-note">
          No headset here, so this is a preview of the room.
        </p>
      )}
      {note && <p class="meta bad">{note}</p>}
      <div class="xr-stage" ref={stage} />
    </Page>
  );
}

/** Takes the round the Enter tap started (app/launch.ts); without one it offers the bare room. */
export function Session(props: { id?: string }) {
  const [launch] = useState(takeLaunch);
  return launch ? <LiveSession launch={launch} /> : <BareRoom id={props.id} />;
}
