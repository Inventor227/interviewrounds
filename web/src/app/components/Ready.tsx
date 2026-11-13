// The last steps before a round: microphone, headset, Start. Used by the round Start page and
// the meeting setup page.
//
// Two explicit taps (app/launch.ts): "Allow microphone" or "Get the room ready" (phase A: the
// prompt with its designed blocked states, then the session and the room load), then "Enter the
// room" (phase B: only the XR request), so nothing slow ever eats the activation XR needs.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { Me } from '../../shared/types';
import { discardLaunch, enterLaunch, launchKey, launchState, prepareLaunch, useLaunch, type PrepareInput } from '../launch';
import { CapNotice } from './CapNotice';
import { capFromError } from './data';
import { getAudioContext } from '../../voice/audio';
import { MIC_CONSTRAINTS } from '../../voice/transport';
import { Qr } from './Qr';

// ---------- Microphone ----------

export type MicState = 'unknown' | 'asking' | 'on' | 'allowed' | 'denied' | 'none' | 'busy' | 'unsupported';
const BLOCKED: MicState[] = ['denied', 'none', 'busy', 'unsupported'];
export const micBlocked = (s: MicState) => BLOCKED.includes(s);

export function micStateFromError(err: unknown): MicState {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'none';
  return 'busy';
}

const hasGetUserMedia = () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';

/** Asks for the mic once. Never throws. */
export async function askMic(): Promise<{ state: MicState; stream: MediaStream | null }> {
  if (!hasGetUserMedia()) return { state: 'unsupported', stream: null };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
    return { state: 'on', stream };
  } catch (err) {
    return { state: micStateFromError(err), stream: null };
  }
}

// The outcome of a mic prompt made on another page (the home button), picked up by the next
// mic step so the user is not asked twice.
let held: { state: MicState; stream: MediaStream | null } | null = null;

export function holdMic(outcome: { state: MicState; stream: MediaStream | null }): void {
  held?.stream?.getTracks().forEach((t) => t.stop());
  held = outcome;
}

function takeHeld() {
  const h = held;
  held = null;
  return h;
}

export interface Mic {
  state: MicState;
  /** Asks for the mic. Resolves with the live stream, or null when blocked. */
  ask(): Promise<MediaStream | null>;
  /** Hands the live stream over (the caller now owns it) and stops metering. */
  take(): MediaStream | null;
  meter: (el: HTMLElement | null) => void;
}

export function useMic(): Mic {
  // Lazy, so only the first render takes a held stream (a later render would drop it unstopped).
  const [first] = useState(takeHeld);
  const [state, setState] = useState<MicState>(() => first?.state ?? (hasGetUserMedia() ? 'unknown' : 'unsupported'));
  const stream = useRef<MediaStream | null>(first?.stream ?? null);
  const meterEl = useRef<HTMLElement | null>(null);
  const stopMeter = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (stream.current) startMeter(stream.current);
  }, []);

  // Read the saved permission, and follow changes made in the browser's site settings.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    const apply = () => {
      if (!status) return;
      setState((s) => {
        if (s === 'on' || s === 'asking') return s;
        if (status!.state === 'granted') return 'allowed';
        if (status!.state === 'denied') return 'denied';
        return s === 'denied' || s === 'allowed' ? 'unknown' : s;
      });
    };
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((s) => {
        status = s;
        apply();
        s.addEventListener?.('change', apply);
      })
      .catch(() => undefined);
    return () => status?.removeEventListener?.('change', apply);
  }, []);

  const startMeter = (s: MediaStream) => {
    const ctx = getAudioContext();
    if (!ctx) return;
    void ctx.resume().catch(() => undefined);
    let src: MediaStreamAudioSourceNode;
    try {
      src = ctx.createMediaStreamSource(s);
    } catch {
      return;
    }
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      meterEl.current?.style.setProperty('--level', level.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    stopMeter.current = () => {
      cancelAnimationFrame(raf);
      src.disconnect();
    };
  };

  const release = () => {
    stopMeter.current?.();
    stopMeter.current = null;
    const s = stream.current;
    stream.current = null;
    return s;
  };

  useEffect(() => () => release()?.getTracks().forEach((t) => t.stop()), []);

  const ask = async (): Promise<MediaStream | null> => {
    if (stream.current) return stream.current;
    setState('asking');
    const out = await askMic();
    setState(out.state);
    if (out.stream) {
      stream.current = out.stream;
      startMeter(out.stream);
    }
    return out.stream;
  };

  return {
    state,
    ask,
    take: () => release(),
    meter: (el) => (meterEl.current = el),
  };
}

const MIC_TEXT: Record<MicState, { title: string; body?: string }> = {
  unknown: { title: 'Allow your microphone', body: 'You answer out loud. The browser asks once.' },
  asking: { title: 'Waiting for your answer', body: 'Allow the microphone in the browser prompt.' },
  on: { title: 'Mic is on', body: 'Say something. The bar should move.' },
  allowed: { title: 'Mic is allowed', body: 'You are set to answer out loud.' },
  denied: { title: 'The microphone is blocked' },
  none: { title: 'No microphone found' },
  busy: { title: 'The microphone is busy' },
  unsupported: { title: 'This browser cannot use a microphone here' },
};

export function MicStep(props: { mic: Mic; action?: ComponentChildren; handedOver?: boolean }) {
  const { mic } = props;
  const s = mic.state;
  const t = MIC_TEXT[s];
  const blocked = micBlocked(s);
  const ok = s === 'on' || s === 'allowed';
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (blocked) ref.current?.focus();
  }, [blocked]);
  return (
    <li class={`step ${ok ? 'step-ok' : blocked ? 'step-bad' : ''}`} data-test="mic-step" data-state={s}>
      <StepMark ok={ok} bad={blocked} n={1} />
      <div class="step-body" ref={ref} tabIndex={-1} aria-live="polite">
        <h3 class="step-title">{t.title}</h3>
        {t.body && <p class="step-text">{t.body}</p>}
        {s === 'on' && !props.handedOver && (
          <div class="meter" ref={mic.meter} data-test="mic-meter" aria-hidden="true">
            <span />
          </div>
        )}
        {!blocked && props.action}
        {s === 'denied' && <MicDenied onRetry={() => void mic.ask()} />}
        {s === 'none' && (
          <div class="help" data-test="mic-none">
            <p>Plug in a headset or a mic, or open this page on your Quest, which has one built in.</p>
            <button type="button" class="btn btn-small" onClick={() => void mic.ask()} data-test="mic-retry">
              Check again
            </button>
          </div>
        )}
        {s === 'busy' && (
          <div class="help" data-test="mic-busy">
            <p>Another app or tab is using it. Close that, then check again.</p>
            <button type="button" class="btn btn-small" onClick={() => void mic.ask()} data-test="mic-retry">
              Check again
            </button>
          </div>
        )}
        {s === 'unsupported' && (
          <div class="help" data-test="mic-unsupported">
            <p>
              Open this page from its secure address in a current browser, such as the Quest Browser, Chrome, Edge or Safari.{' '}
              <a href="/not-supported">What works</a>
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

function MicDenied(props: { onRetry: () => void }) {
  return (
    <div class="help help-denied" data-test="mic-denied">
      <p>Rounds are spoken, so the mic has to be on. To turn it back on:</p>
      <div class="howto">
        <div>
          <h4>In the Quest Browser</h4>
          <ol>
            <li>Select the lock icon left of the address.</li>
            <li>Set Microphone to Allow.</li>
            <li>Come back here and select Check again.</li>
          </ol>
          <p class="fine">
            Still blocked? On your Quest open Settings, then Privacy and safety, then App permissions, Microphone, and turn it on
            for Browser.
          </p>
        </div>
        <div>
          <h4>On a computer or phone</h4>
          <ol>
            <li>Select the icon left of the address.</li>
            <li>Allow the microphone for this site.</li>
            <li>Select Check again.</li>
          </ol>
        </div>
      </div>
      <button type="button" class="btn btn-small" onClick={props.onRetry} data-test="mic-retry">
        Check again
      </button>
    </div>
  );
}

function StepMark(props: { ok: boolean; bad: boolean; n: number }) {
  return (
    <span class="step-mark" aria-hidden="true">
      {props.ok ? (
        <svg viewBox="0 0 20 20" width="18" height="18">
          <path d="M5 10.5l3.2 3L15 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ) : props.bad ? (
        '!'
      ) : (
        props.n
      )}
    </span>
  );
}

// ---------- Headset ----------

export type XrState = 'checking' | 'ready' | 'none';

export function useHeadset(forcePreview = false): XrState {
  const [state, setState] = useState<XrState>(() => (forcePreview || typeof navigator === 'undefined' || !navigator.xr ? 'none' : 'checking'));
  useEffect(() => {
    if (forcePreview) return setState('none');
    const xr = navigator.xr;
    if (!xr) return setState('none');
    let live = true;
    xr.isSessionSupported('immersive-ar')
      .then((ok) => live && setState(ok ? 'ready' : 'none'))
      .catch(() => live && setState('none'));
    return () => {
      live = false;
    };
  }, [forcePreview]);
  return state;
}

export function HeadsetStep(props: { xr: XrState; questUrl: string; questNote?: string }) {
  const { xr } = props;
  return (
    <li class={`step ${xr === 'ready' ? 'step-ok' : ''}`} data-test="headset-step" data-state={xr}>
      <StepMark ok={xr === 'ready'} bad={false} n={2} />
      <div class="step-body">
        {xr === 'checking' && <h3 class="step-title">Looking for a headset</h3>}
        {xr === 'ready' && (
          <>
            <h3 class="step-title">Headset ready</h3>
            <p class="step-text">The room opens in passthrough. Sit at your desk with some space in front of you.</p>
            <p class="step-text hands" data-test="hands-note">
              Use your hands. Controllers are optional.
            </p>
          </>
        )}
        {xr === 'none' && (
          <div data-test="headset-none">
            <h3 class="step-title">No headset on this device</h3>
            <p class="step-text">
              You can preview the round here with the same interviewer and voice. For the full room, open this page on your Quest.
            </p>
            <div class="quest">
              <Qr text={props.questUrl} label="QR code with the link to this round" />
              <div class="quest-text">
                <p>
                  <strong>Open on Quest</strong>
                </p>
                <p class="fine">Scan with your phone and send it to your Quest, or type this address in the Quest Browser:</p>
                <p class="url" data-test="quest-url">
                  {props.questUrl.replace(/^https?:\/\//, '')}
                </p>
                {props.questNote && <p class="fine">{props.questNote}</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

// ---------- Panel ----------

export function ReadyPanel(props: {
  mic: Mic;
  xr: XrState;
  questUrl: string;
  /** One line under the QR code (what opening it on the Quest keeps). */
  questNote?: string;
  /** What to prepare; null while it is not known yet (no meeting plan). */
  input: PrepareInput | null;
  title?: string;
  /** Rendered instead of the Enter button, e.g. a CapNotice. */
  blocked?: ComponentChildren;
  enterLabel?: string;
  /** One line under the Enter button once it is ready. */
  hint?: ComponentChildren;
  /** Something on the page is not settled (e.g. edits to apply first). */
  busy?: boolean;
  error?: ComponentChildren;
  me?: Me;
}) {
  const { mic, xr, input } = props;
  const { route } = useLocation();
  const preview = xr === 'none';
  const blocked = micBlocked(mic.state);
  const launch = useLaunch();
  const key = input ? launchKey(input, preview) : null;
  const mine = launch.status !== 'idle' && launch.key === key ? launch : null;

  // A prepared round for other inputs (Adjust changed, plan changed) is stale: drop it. Leaving
  // the page without entering drops ours too.
  useEffect(() => {
    if (launch.status !== 'idle' && launch.key !== key) discardLaunch();
  }, [key, launch.status === 'idle' ? null : launch.key]);
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(
    () => () => {
      const now = launchState();
      if (now.status !== 'idle' && now.key === keyRef.current) discardLaunch();
    },
    [],
  );

  // Phase A: the mic (one prompt at most), then the session and the room.
  const phaseA = async () => {
    if (!input || props.busy) return;
    const stream = await mic.ask();
    if (!stream) return;
    void prepareLaunch(input, { mic: mic.take(), preview, title: props.title });
  };
  // Phase B: synchronous, so the XR request runs inside this tap.
  const phaseB = () => {
    if (mine?.status === 'ready') enterLaunch(route);
  };

  const preparing = mine?.status === 'preparing';
  const ready = mine?.status === 'ready';
  const failed = mine?.status === 'failed' ? mine.error : null;
  const cap = failed ? capFromError(failed) : null;
  const micReady = mic.state === 'on' || mic.state === 'allowed';
  const showPhaseA = !blocked && !preparing && !ready && mic.state !== 'asking';

  const phaseAButton = showPhaseA ? (
    <button
      type="button"
      class="btn btn-primary btn-big"
      onClick={() => void phaseA()}
      disabled={!input || props.busy || xr === 'checking'}
      data-test="mic-allow"
    >
      {failed ? 'Try again' : micReady ? 'Get the room ready' : 'Allow microphone'}
    </button>
  ) : null;

  return (
    <div class="ready" data-test="ready" data-launch={mine?.status ?? 'none'}>
      <ol class="steps">
        <MicStep mic={mic} action={phaseAButton} handedOver={!!mine} />
        <HeadsetStep xr={xr} questUrl={props.questUrl} questNote={props.questNote} />
      </ol>
      {props.error}
      {cap ? (
        <CapNotice reason={cap.reason} resetsAt={cap.resetsAt} isGuest={props.me?.identity.kind !== 'user'} signInAvailable={props.me?.sign_in_available} />
      ) : failed ? (
        <p class="note-warn" role="alert" data-test="prepare-failed">
          {prepareFailText(failed)}
        </p>
      ) : null}
      {props.blocked ??
        (cap ? null : (
          <div class="start-row">
            <button
              type="button"
              class="btn btn-primary btn-big"
              data-test={preview ? 'start-preview' : 'start-round'}
              disabled={!ready || props.busy}
              aria-describedby="enter-note"
              onClick={phaseB}
            >
              {props.enterLabel ?? (preview ? 'Preview on this screen' : 'Enter the room')}
            </button>
            <p class="fine" id="enter-note" aria-live="polite" data-test="enter-note">
              {blocked
                ? 'Turn the microphone on first. Everything else is ready.'
                : preparing
                  ? 'Getting the room ready.'
                  : ready
                    ? (props.hint ?? (preview ? 'Ready.' : 'Ready. Put on your headset if it is not on yet.'))
                    : 'Allow the microphone first. The room gets ready in a few seconds.'}
            </p>
          </div>
        ))}
    </div>
  );
}

function prepareFailText(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  const status = (err as { status?: number } | null)?.status;
  if (code === 'network' || status === 0) return 'We could not reach the server. Check your connection, then try again.';
  if (code === 'room_load_failed') return 'The room did not load on this device. Try again.';
  if (code === 'mic_denied' || code === 'no_mic' || code === 'mic_busy') return 'The microphone stopped working. Check it, then try again.';
  return 'The round could not be set up. Try again.';
}
