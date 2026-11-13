// The live round page. On a headset the round runs in the room and this page is what the user
// comes back to: its state, the way back in if they left the headset view, and the way on to the
// report. Without a headset it shows the preview room on screen, with the sheet to draw on by
// mouse in rounds that have one.

import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { DevConsole } from '../../session/DevConsole';
import { isDebug } from '../../session/browser';
import type { ControllerState } from '../../session/ports';
import { liveRoom, type LiveRoom } from '../../session/room';
import type { StageSpans } from '../../session/timings';
import type { ImmersiveHandle } from '../../xr/entry';
import { Page } from '../components/Ui';
import { takeLaunch } from '../launch';

type Taken = NonNullable<ReturnType<typeof takeLaunch>>;

/** What the page says for each state of the round (plain, one line). */
export const STATE_LINE: Record<ControllerState, string> = {
  idle: 'Getting the room ready.',
  placing: 'Touch your desk where the sheet should go.',
  greeting: 'Your interviewer is saying hello.',
  live: 'Your round is live.',
  paused: 'Paused. Press Resume when you are ready.',
  ending: 'Wrapping up.',
  scoring: 'Writing your scorecard.',
  summary: 'Your scorecard is ready.',
  failed: 'The round could not start.',
};

/** Errors that end the round on this page; the rest show in the room or pass by themselves. */
const FATAL = new Set(['connect_failed', 'session_expired', 'no_credit', 'socket_terminal', 'voice_lost', 'room_load_failed']);

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
    <section class="session-board" aria-label="Your sheet" data-test="session-board">
      <h2>Your sheet</h2>
      <p class="meta">Draw a box for a part of the system, or pull a card from the tray. Draw a line from one card to another to connect them.</p>
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
  // Whether the interviewer ever spoke: a failure before that is a round that never began.
  const [began, setBegan] = useState(controller.state === 'live');
  const [, bump] = useState(0);
  const debug = isDebug();
  const dev = import.meta.env.DEV;
  const fakeVoice = session.panel.some((p) => p.voice.transport === 'fake');

  useEffect(() => {
    const current = () => controller.session ?? props.launch.session;
    const offs = [
      controller.on('state', (s) => {
        setState(s);
        if (s === 'live') setBegan(true);
      }),
      controller.on('session', setSession),
      controller.on('error', (e) => {
        // The user ended the round before it began: nothing to show, back home.
        if ((e as { code: string }).code === 'cancelled') route('/');
        else setError(e as { code: string });
      }),
      // The room's own buttons: leaving this page ends the headset session and frees the room.
      controller.on('action', (a) => {
        const sid = encodeURIComponent(current().session_id);
        route(a === 'report' ? `/report/${sid}` : `/round/${encodeURIComponent(current().round.id)}?retry=${sid}`);
      }),
      room?.onChange(() => bump((n) => n + 1)) ?? (() => undefined),
    ];
    if (dev) (globalThis as { __round?: unknown }).__round = { controller, room, get session() { return current(); }, timings: () => room?.timings.spans() };
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
  const lost = !!room?.sessionLost && !over && !preview && state !== 'failed';
  const retryEnter = !lost && state !== 'failed' && (error?.code === 'xr_enter_failed' || error?.code === 'placement_failed');
  const failed = !over && (state === 'failed' || (!!error && FATAL.has(error.code)));
  // Before the first word there is no round to lose and no report to see: offer the start again.
  const neverBegan = failed && !began;
  const lostRound = failed && began;
  const lede = preview ? 'No headset here, so this is a preview of the room on your screen.' : 'Your round runs in the headset. This page waits for you.';
  const back = (tap: () => Promise<void>) => {
    setNote('');
    setError(null);
    tap().catch(() => setNote('The headset did not start the room. Tap again.'));
  };

  return (
    <Page test="session" title={props.launch.title ?? session.round.title ?? 'Live round'} lede={lede} wide={preview}>
      {!failed && (
        <p class="note" role="status" data-test="session-state" data-state={state}>
          {STATE_LINE[state]}
        </p>
      )}
      {retryEnter && (
        <div class="row">
          <button class="btn btn-primary btn-big" data-test="enter-room" onClick={() => back(() => controller.enter())}>
            Enter the room
          </button>
        </div>
      )}
      {lost && (
        <div class="row">
          {/* Through the controller: before the round began this is the start itself, later a paused round to resume. */}
          <button class="btn btn-primary btn-big" data-test="return-to-room" onClick={() => back(() => controller.returnToRoom())}>
            Return to the room
          </button>
          <button class="btn" data-test="end-from-page" onClick={() => controller.end()}>
            End the round
          </button>
        </div>
      )}
      {over && (
        <div class="row">
          <a class="btn btn-primary" data-test="see-report" href={`/report/${sid}`}>
            See full report
          </a>
        </div>
      )}
      {neverBegan && (
        <div class="state state-error" role="alert" data-test="session-not-started" data-code={error?.code}>
          <h2>Couldn't start the round</h2>
          <p>Your interviewer did not make it into the room. Nothing was used up. Try it again.</p>
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
          <p>The connection to your interviewer dropped. What you said so far is saved.</p>
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
    <Page test="session" title="Live round" lede="This round is not running on this page. Start a new one from home, or look around the room.">
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
