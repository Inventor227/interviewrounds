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

function LiveSession(props: { launch: Taken }) {
  const { controller, session, preview } = props.launch;
  const { route } = useLocation();
  const [room] = useState(liveRoom);
  const [state, setState] = useState(controller.state);
  const [error, setError] = useState<{ code: string } | null>(null);
  const [note, setNote] = useState('');
  const [, bump] = useState(0);
  const debug = isDebug();
  const dev = import.meta.env.DEV;
  const fakeVoice = session.panel.some((p) => p.voice.transport === 'fake');

  useEffect(() => {
    const sid = encodeURIComponent(session.session_id);
    const offs = [
      controller.on('state', setState),
      controller.on('error', (e) => setError(e as { code: string })),
      // The room's own buttons: leaving this page ends the headset session and frees the room.
      controller.on('action', (a) => route(a === 'report' ? `/report/${sid}` : `/round/${encodeURIComponent(session.round.id)}?retry=${sid}`)),
      room?.onChange(() => bump((n) => n + 1)) ?? (() => undefined),
    ];
    if (dev) (globalThis as { __round?: unknown }).__round = { controller, room, session, timings: () => room?.timings.spans() };
    return () => {
      offs.forEach((o) => o());
      if (dev) delete (globalThis as { __round?: unknown }).__round;
      void controller.dispose();
    };
  }, [controller]);

  // The canvas shows on the page in the preview; in the headset only tooling needs to see it.
  const stage = useStage(room, preview || dev);
  const retryEnter = error?.code === 'xr_enter_failed' || error?.code === 'placement_failed';
  const over = state === 'scoring' || state === 'summary';
  const fatal = !!error && (state === 'failed' || FATAL.has(error.code)) && !over;
  const lost = !!room?.sessionLost && !over && !preview;
  const lede = preview ? 'No headset here, so this is a preview of the room on your screen.' : 'Your round runs in the headset. This page waits for you.';

  return (
    <Page test="session" title={props.launch.title ?? session.round.title ?? 'Live round'} lede={lede} wide={preview}>
      <p class="note" role="status" data-test="session-state" data-state={state}>
        {STATE_LINE[state]}
      </p>
      {retryEnter && !lost && (
        <div class="row">
          <button
            class="btn btn-primary btn-big"
            data-test="enter-room"
            onClick={() => {
              setError(null);
              controller.enter().catch(() => undefined);
            }}
          >
            Enter the room
          </button>
        </div>
      )}
      {lost && (
        <div class="row">
          <button
            class="btn btn-primary btn-big"
            data-test="return-to-room"
            onClick={() => {
              setNote('');
              room?.reenter().catch(() => setNote('The headset did not start the room. Tap again.'));
            }}
          >
            Return to the room
          </button>
          <button class="btn" data-test="end-from-page" onClick={() => controller.end()}>
            End the round
          </button>
        </div>
      )}
      {over && (
        <div class="row">
          <a class="btn btn-primary" data-test="see-report" href={`/report/${encodeURIComponent(session.session_id)}`}>
            See full report
          </a>
        </div>
      )}
      {fatal && (
        <div class="state state-error" role="alert" data-test="session-error" data-code={error?.code}>
          <h2>We lost the round</h2>
          <p>The connection to your interviewer dropped. What you said so far is saved.</p>
          <div class="row">
            <a class="btn btn-primary" href={`/report/${encodeURIComponent(session.session_id)}`}>
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
      {(debug || (dev && fakeVoice)) && <DevConsole source={controller} />}
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
