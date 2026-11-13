// The last steps before a round: microphone, headset, Start. Used by the round Start page and
// the meeting setup page.
//
// Two explicit taps: "Allow microphone" (the prompt and the designed blocked states), then
// "Enter the room", which hands the round to the session page inside that tap (app/launch.ts),
// so no prompt ever eats the user activation that entering XR needs.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
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
  const first = useRef(takeHeld());
  const [state, setState] = useState<MicState>(() => first.current?.state ?? (hasGetUserMedia() ? 'unknown' : 'unsupported'));
  const stream = useRef<MediaStream | null>(first.current?.stream ?? null);
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

export function MicStep(props: { mic: Mic }) {
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
        {s === 'on' && (
          <div class="meter" ref={mic.meter} data-test="mic-meter" aria-hidden="true">
            <span />
          </div>
        )}
        {s === 'unknown' && (
          <button type="button" class="btn btn-primary btn-big" onClick={() => void mic.ask()} data-test="mic-allow">
            Allow microphone
          </button>
        )}
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
              Open this page from its secure address in a current browser, such as the Quest Browser, Chrome, Edge or Safari.
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

export function HeadsetStep(props: { xr: XrState; questUrl: string }) {
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
  /** Rendered instead of the Start button, e.g. a CapNotice. */
  blocked?: ComponentChildren;
  /** Called inside the Start tap with the mic stream (when it is live) and whether this is a 2D preview. */
  onStart: (opts: { preview: boolean; mic: MediaStream | null }) => void;
  startLabel?: string;
  /** One line under the Start button once it is ready. */
  hint?: ComponentChildren;
  busy?: boolean;
  error?: ComponentChildren;
}) {
  const { mic, xr } = props;
  const preview = xr === 'none';
  const blocked = micBlocked(mic.state);

  const micReady = mic.state === 'on' || mic.state === 'allowed';
  // Synchronous on purpose: this tap's activation is what lets the session page enter XR.
  const start = () => {
    if (micReady) props.onStart({ preview, mic: mic.take() });
  };

  return (
    <div class="ready" data-test="ready">
      <ol class="steps">
        <MicStep mic={mic} />
        <HeadsetStep xr={xr} questUrl={props.questUrl} />
      </ol>
      {props.error}
      {props.blocked ?? (
        <div class="start-row">
          <button
            type="button"
            class="btn btn-primary btn-big"
            data-test={preview ? 'start-preview' : 'start-round'}
            disabled={!micReady || xr === 'checking' || props.busy}
            onClick={start}
          >
            {props.startLabel ?? (preview ? 'Preview on this screen' : 'Enter the room')}
          </button>
          {blocked ? (
            <p class="fine">Turn the microphone on first. Everything else is ready.</p>
          ) : !micReady ? (
            <p class="fine">Allow the microphone first.</p>
          ) : props.hint ? (
            <p class="fine">{props.hint}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
