// Device check (/diag): one page for a real headset test. Steps run one at a time, each with one button; the
// numbers at the end are copied or sent to the server (POST /api/diag). Not linked from the app's flows.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DiagError, devKey, echoVoice, sendResults } from '../../diag/api';
import type { EchoRun, EchoTest, EchoUpdate } from '../../diag/echo';
import { deviceFacts, MicTest, playTone, toneUrl, type DeviceFacts, type MicResult, type PlayResult } from '../../diag/probe';
import type { XrResults, XrStage, XrTest } from '../../diag/xrTest';
import { Page } from '../components/Ui';

type Tone = 'good' | 'warn' | 'bad' | undefined;
type Row = [label: string, value: ComponentChildren, tone?: Tone];

const fmt = (v: unknown, unit = ''): string => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return 'n/a';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  return `${String(v)}${unit}`;
};
const tone = (ok: boolean | null | undefined, warn = false): Tone => (ok === null || ok === undefined ? undefined : ok ? 'good' : warn ? 'warn' : 'bad');

function Kv(props: { rows: Row[]; test: string }) {
  return (
    <dl class="diag-kv" data-test={props.test}>
      {props.rows.map(([k, v, t]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd class={t}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Step(props: { n: number; title: string; hint: string; children?: ComponentChildren; test: string }) {
  return (
    <section class="card diag-step" data-test={`diag-${props.test}`} aria-labelledby={`diag-h-${props.test}`}>
      <h2 id={`diag-h-${props.test}`} class="section-title">
        <span class="diag-n">{props.n}</span> {props.title}
      </h2>
      <p class="field-hint">{props.hint}</p>
      {props.children}
    </section>
  );
}

function Meter(props: { db: number | null }) {
  const pct = props.db === null ? 0 : Math.max(0, Math.min(100, ((props.db + 70) / 70) * 100));
  return (
    <div class="diag-meter" role="meter" aria-label="Microphone level" aria-valuemin={-70} aria-valuemax={0} aria-valuenow={props.db ?? -70}>
      <div style={{ width: `${pct}%` }} />
      <span>{props.db === null ? 'no level' : `${props.db.toFixed(0)} dB`}</span>
    </div>
  );
}

// ---- 1. device ----

function useDevice() {
  const [facts, setFacts] = useState<DeviceFacts | null>(null);
  const run = () => void deviceFacts().then(setFacts);
  useEffect(run, []);
  return { facts, run };
}

function deviceRows(f: DeviceFacts): Row[] {
  return [
    ['Browser', f.ua],
    ['Quest Browser', fmt(f.quest), tone(f.quest, true)],
    ['WebXR', fmt(f.webxr), tone(f.webxr)],
    ['Passthrough (immersive-ar)', fmt(f.immersive_ar), tone(f.immersive_ar === true)],
    ['VR (immersive-vr)', fmt(f.immersive_vr)],
    ['Hand API (XRHand)', fmt(f.xr_hand_api), tone(f.xr_hand_api)],
    ['Audio sample rate', fmt(f.audio.sample_rate, ' Hz')],
    ['Audio latency', `${fmt(f.audio.base_latency_ms, ' ms')} base, ${fmt(f.audio.output_latency_ms, ' ms')} output`],
    ['Pixel ratio', fmt(f.dpr)],
    ['Screen and page', `${f.screen}, ${f.viewport}`],
    ['GPU', fmt(f.webgl?.renderer)],
    ['Multiview', fmt(f.webgl?.multiview)],
    ['Mic permission', f.mic_permission],
    ['Echo cancel supported', fmt(f.mic_constraints?.echoCancellation), tone(f.mic_constraints?.echoCancellation)],
    ['WebRTC', fmt(f.webrtc), tone(f.webrtc)],
    ['Network', `${fmt(f.network.type)}, rtt ${fmt(f.network.rtt_ms, ' ms')}`],
  ];
}

// ---- page ----

export function Diag() {
  const device = useDevice();

  // 2. microphone
  const [micDb, setMicDb] = useState<number | null>(null);
  const mic = useMemo(() => new MicTest((db) => setMicDb(db)), []);
  const [micRes, setMicRes] = useState<MicResult | null>(null);
  const [micOn, setMicOn] = useState(false);

  // 3. autoplay: the first try runs on load, before any tap.
  const tone_ = useMemo(() => toneUrl(), []);
  const [auto, setAuto] = useState<{ without_tap: PlayResult | null; with_tap: PlayResult | null; heard: boolean | null }>({ without_tap: null, with_tap: null, heard: null });
  useEffect(() => {
    void playTone(tone_).then((r) => setAuto((a) => ({ ...a, without_tap: r })));
  }, [tone_]);

  // 4 and 5. XR (created ahead so the tap only enters)
  const stage = useRef<HTMLDivElement>(null);
  const [xr, setXr] = useState<XrTest | null>(null);
  const [xrState, setXrState] = useState<{ stage: XrStage | 'loading' | 'none'; line: string }>({ stage: 'loading', line: 'Loading the room.' });
  const [xrRes, setXrRes] = useState<XrResults | null>(null);
  useEffect(() => {
    let live = true;
    let made: XrTest | null = null;
    import('../../diag/xrTest')
      .then((m) =>
        m.createXrTest(stage.current as HTMLElement, (s, line) => {
          setXrState({ stage: s, line });
          if (made) setXrRes(structuredClone(made.results));
        }),
      )
      .then((t) => {
        made = t;
        if (!live) return t?.destroy();
        setXr(t);
        setXrState(t ? { stage: 'idle', line: 'Ready.' } : { stage: 'none', line: 'This browser cannot open passthrough (immersive-ar).' });
      })
      .catch((e: Error) => live && setXrState({ stage: 'none', line: `The room did not load: ${e.message}` }));
    return () => {
      live = false;
      made?.destroy();
    };
  }, []);
  useEffect(() => {
    if (!xr) return;
    const id = setInterval(() => setXrRes(structuredClone(xr.results)), 1000);
    return () => clearInterval(id);
  }, [xr]);

  // 6. echo
  const [key, setKey] = useState(devKey.get());
  const [confirming, setConfirming] = useState(false);
  const [echo, setEcho] = useState<EchoTest | null>(null);
  const [echoLive, setEchoLive] = useState<EchoUpdate | null>(null);
  const [echoRun, setEchoRun] = useState<EchoRun | null>(null);
  const [echoErr, setEchoErr] = useState('');
  useEffect(() => () => echo?.stop(), [echo]);

  const startEcho = async () => {
    setConfirming(false);
    setEchoErr('');
    setEchoRun(null);
    devKey.set(key.trim());
    if (mic.running) {
      setMicRes(mic.stop());
      setMicOn(false);
    }
    try {
      const { voice } = await echoVoice(key.trim());
      const { EchoTest: Test } = await import('../../diag/echo');
      const t = new Test(setEchoLive);
      setEcho(t);
      setEchoRun(await t.start(voice));
    } catch (e) {
      setEchoErr(e instanceof DiagError ? `${e.code}: ${e.message}` : String(e));
    }
  };

  // 7. results
  const [note, setNote] = useState('');
  const [sent, setSent] = useState('');
  const payload = {
    version: 1,
    at: new Date().toISOString(),
    path: location.pathname,
    device: device.facts,
    mic: micRes,
    autoplay: auto,
    xr: xrRes,
    echo: echoRun,
    note: note.slice(0, 4000),
  };
  const json = JSON.stringify(payload, null, 1);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setSent('Copied.');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = json;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      setSent(ok ? 'Copied.' : 'Copy did not work here. Use Send results.');
    }
  };
  const send = async () => {
    setSent('Sending.');
    try {
      const r = await sendResults(payload);
      setSent(`Sent. Result number ${r.id}.`);
    } catch (e) {
      setSent(e instanceof DiagError ? `Not sent (${e.code}): ${e.message}` : 'Not sent.');
    }
  };

  const x = xrRes;
  const h = x?.hands;
  const e = echoRun?.results;
  const xrBusy = !['idle', 'done', 'ended', 'failed', 'none', 'loading'].includes(xrState.stage);

  return (
    <Page test="diag" title="Device check" lede="Run each step in order. Every step has one button. Send the results at the end.">
      <Step n={1} test="device" title="Device and browser" hint="Read on load. Check again after you allow the microphone.">
        <div class="row">
          <button class="btn btn-big" data-test="diag-device-run" onClick={device.run}>
            Check again
          </button>
        </div>
        {device.facts ? <Kv test="diag-device-kv" rows={deviceRows(device.facts)} /> : <p class="meta">Reading.</p>}
      </Step>

      <Step n={2} test="mic" title="Microphone" hint="Tap, allow the microphone, stay quiet for 3 seconds, then count to five out loud. Then tap Stop.">
        <div class="row">
          {!micOn ? (
            <button
              class="btn btn-primary btn-big"
              data-test="diag-mic-run"
              onClick={async () => {
                setMicOn(true);
                setMicRes(await mic.start());
              }}
            >
              Test the microphone
            </button>
          ) : (
            <button
              class="btn btn-primary btn-big"
              data-test="diag-mic-stop"
              onClick={() => {
                setMicRes({ ...mic.stop() });
                setMicOn(false);
                setMicDb(null);
              }}
            >
              Stop
            </button>
          )}
        </div>
        {micOn && <Meter db={micDb} />}
        {micRes && (
          <Kv
            test="diag-mic-kv"
            rows={[
              ['Permission', `${micRes.permission_before} then ${fmt(micRes.permission_after)}`],
              ['Time to allow', fmt(micRes.grant_ms, ' ms')],
              ['Error', fmt(micRes.error), micRes.error ? 'bad' : undefined],
              ['Echo cancellation', fmt(micRes.settings?.echoCancellation), tone(micRes.settings?.echoCancellation === true)],
              ['Noise suppression', fmt(micRes.settings?.noiseSuppression), tone(micRes.settings?.noiseSuppression === true, true)],
              ['Auto gain', fmt(micRes.settings?.autoGainControl), tone(micRes.settings?.autoGainControl === true, true)],
              ['Mic sample rate', fmt(micRes.settings?.sampleRate, ' Hz')],
              ['Room level (quiet)', fmt(micRes.level?.p20_db, ' dB')],
              ['Voice level (loud)', fmt(micRes.level?.p95_db, ' dB')],
            ]}
          />
        )}
      </Step>

      <Step n={3} test="autoplay" title="Sound without a tap" hint="A short tone played when the page opened. Tap to play it again, then say whether you heard it.">
        <div class="row">
          <button class="btn btn-primary btn-big" data-test="diag-tone" onClick={async () => setAuto({ ...auto, with_tap: await playTone(tone_) })}>
            Play a tone
          </button>
          <button class="btn btn-big" data-test="diag-heard-yes" aria-pressed={auto.heard === true} onClick={() => setAuto({ ...auto, heard: true })}>
            I heard it
          </button>
          <button class="btn btn-big" data-test="diag-heard-no" aria-pressed={auto.heard === false} onClick={() => setAuto({ ...auto, heard: false })}>
            No sound
          </button>
        </div>
        <Kv
          test="diag-autoplay-kv"
          rows={[
            ['Without a tap', fmt(auto.without_tap?.media), tone(auto.without_tap ? auto.without_tap.media === 'played' : null, true)],
            ['Page had a tap before', fmt(auto.without_tap?.had_activation)],
            ['Audio state on load', fmt(auto.without_tap?.context_state)],
            ['After a tap', fmt(auto.with_tap?.media), tone(auto.with_tap ? auto.with_tap.media === 'played' : null)],
            ['Heard it', fmt(auto.heard), tone(auto.heard)],
          ]}
        />
      </Step>

      <Step
        n={4}
        test="xr"
        title="Room, people and frame rate"
        hint="Sit at your desk. Tap Start, then touch the desk where the sheet should go. Sit still for 30 seconds while the frame test runs."
      >
        <div class="row">
          <button
            class="btn btn-primary btn-big"
            data-test="diag-xr-run"
            disabled={!xr || xrBusy}
            onClick={() => {
              if (mic.running) {
                setMicRes(mic.stop());
                setMicOn(false);
              }
              xr?.enter(performance.now());
            }}
          >
            Start the headset test
          </button>
        </div>
        <p class="meta" data-test="diag-xr-state" data-stage={xrState.stage} aria-live="polite">
          {xrState.line}
        </p>
        {x && (
          <Kv
            test="diag-xr-kv"
            rows={[
              ['Tap to first frame', fmt(x.tap_to_first_frame_ms, ' ms'), tone(x.tap_to_first_frame_ms === null ? null : x.tap_to_first_frame_ms < 3000, true)],
              ['Features on', fmt(x.enabled_features)],
              ['Hand tracking on', fmt(x.enabled_features ? x.enabled_features.includes('hand-tracking') : null), tone(x.enabled_features ? x.enabled_features.includes('hand-tracking') : null)],
              ['Frame rates offered', fmt(x.supported_frame_rates)],
              ['Rate at start', fmt(x.start_frame_rate, ' Hz')],
              ['Desk placed by', x.placement ? `${x.placement.source} in ${x.placement.ms} ms` : 'n/a'],
              [
                '72 Hz frames',
                x.frames_72 ? `p50 ${x.frames_72.p50_ms}, p90 ${x.frames_72.p90_ms}, p99 ${x.frames_72.p99_ms} ms, late ${x.frames_72.late_pct}%, ${x.frames_72.fps} fps` : 'n/a',
                x.frames_72 ? tone(x.frames_72.late_pct < 1, x.frames_72.late_pct < 5) : undefined,
              ],
              ['90 Hz asked', x.rate_90.tried ? `${fmt(x.rate_90.ok)}, now ${fmt(x.rate_90.frame_rate_after, ' Hz')}` : 'not offered'],
              [
                '90 Hz frames',
                x.frames_90 ? `p50 ${x.frames_90.p50_ms}, p90 ${x.frames_90.p90_ms}, p99 ${x.frames_90.p99_ms} ms, late ${x.frames_90.late_pct}%, ${x.frames_90.fps} fps` : 'n/a',
                x.frames_90 ? tone(x.frames_90.late_pct < 1, x.frames_90.late_pct < 5) : undefined,
              ],
              ['Draw calls, triangles', x.render ? `${x.render.calls}, ${x.render.triangles}` : 'n/a', x.render ? tone(x.render.calls < 60 && x.render.triangles < 60000, true) : undefined],
              ['Controllers seen', fmt(x.controllers_seen)],
              ['Error', fmt(x.error), x.error ? 'bad' : undefined],
            ]}
          />
        )}
      </Step>

      <Step n={5} test="hands" title="Hands on the sheet" hint="Runs in the headset after the frame test. Follow the sheet: hold a pinch still, draw a line, tap five rings, then pinch Done.">
        {x && (
          <Kv
            test="diag-hands-kv"
            rows={[
              ['Hold still, filtered', h?.hold.filtered ? `${h.hold.filtered.rms_cm} cm RMS, max ${h.hold.filtered.max_cm}` : 'n/a', h?.hold.filtered ? tone(h.hold.filtered.rms_cm < 0.2, h.hold.filtered.rms_cm < 0.4) : undefined],
              ['Hold still, raw', h?.hold.raw ? `${h.hold.raw.rms_cm} cm RMS, max ${h.hold.raw.max_cm}` : 'n/a'],
              [
                'Line, filtered',
                h?.line.filtered ? `${h.line.filtered.rms_cm} cm RMS off straight, ${h.line.filtered.length_cm} cm long, ends off ${h.line.filtered.start_err_cm} and ${h.line.filtered.end_err_cm}` : 'n/a',
                h?.line.filtered ? tone(h.line.filtered.rms_cm < 0.3, h.line.filtered.rms_cm < 0.6) : undefined,
              ],
              ['Line, raw', h?.line.raw ? `${h.line.raw.rms_cm} cm RMS off straight` : 'n/a'],
              [
                'Taps',
                h?.targets.stats ? `${h.targets.stats.hits} of ${h.targets.stats.taps} hit, off by ${h.targets.stats.mean_dist_cm} cm (x ${h.targets.stats.mean_dx_cm}, y ${h.targets.stats.mean_dy_cm})` : 'n/a',
                h?.targets.stats ? tone(h.targets.stats.rate >= 0.8, h.targets.stats.rate >= 0.6) : undefined,
              ],
              ['Pinches (fingers) and selects', `${x.finger_pinches} pinches, ${x.selects.starts} selects, ${x.selects.cancels} cancelled`],
              ['Selects per pinch', fmt(x.select_per_pinch), x.select_per_pinch === null ? undefined : tone(x.select_per_pinch >= 0.9, x.select_per_pinch >= 0.75)],
              ['Hands tracked', x.tracked_pct ? `left ${x.tracked_pct.left}%, right ${x.tracked_pct.right}%` : 'n/a'],
              ['Gestures lost', fmt(h?.lost)],
              ['Tries', h ? `hold ${h.hold.tries}, line ${h.line.tries}` : 'n/a'],
            ]}
          />
        )}
      </Step>

      <Step
        n={6}
        test="echo"
        title="Echo and talking over"
        hint="Uses the paid voice service for about a minute. Use the headset speakers, no headphones. Stay silent while she reads. When she asks you to, talk over her."
      >
        <div class="field">
          <label for="diag-key">Dev key</label>
          <input id="diag-key" type="password" autocomplete="off" value={key} onInput={(ev) => setKey(ev.currentTarget.value)} data-test="diag-key" />
        </div>
        <div class="row">
          {!confirming && !(echoLive && !echoRun && !echoErr) && (
            <button class="btn btn-primary btn-big" data-test="diag-echo-run" disabled={!key.trim()} onClick={() => setConfirming(true)}>
              Run the 60 s echo test
            </button>
          )}
          {confirming && (
            <>
              <button class="btn btn-primary btn-big" data-test="diag-echo-confirm" onClick={() => void startEcho()}>
                Start now, about $0.07
              </button>
              <button class="btn btn-big" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          )}
          {echoLive && !echoRun && !echoErr && (
            <button class="btn btn-big" data-test="diag-echo-stop" onClick={() => echo?.stop()}>
              Stop
            </button>
          )}
        </div>
        {echoLive && !echoRun && (
          <p class="meta" aria-live="polite" data-test="diag-echo-live">
            {echoLive.phase === 'connecting' && 'Connecting.'}
            {echoLive.phase === 'waiting' && 'Waiting for her voice.'}
            {echoLive.phase === 'silent' && `Stay silent. ${echoLive.remaining_s} s. Heard so far: ${echoLive.heard}.`}
            {echoLive.phase === 'barge' && `Talk over her now. ${echoLive.remaining_s} s.`}
          </p>
        )}
        {echoLive && !echoRun && echoLive.phase !== 'connecting' && <Meter db={echoLive.mic_db} />}
        {echoErr && <p class="meta bad">{echoErr}</p>}
        {echoRun && (
          <Kv
            test="diag-echo-kv"
            rows={[
              ['Ended', fmt(echoRun.stopped_by), tone(echoRun.stopped_by === 'finished', true)],
              ['Error', fmt(echoRun.error), echoRun.error ? 'bad' : undefined],
              ['Voice mic echo cancel', fmt(echoRun.fish_mic?.echoCancellation), tone(echoRun.fish_mic ? echoRun.fish_mic.echoCancellation === true : null)],
              ['Connect, first word', `${fmt(e?.connect_ms, ' ms')}, ${fmt(e?.first_speech_ms, ' ms')}`],
              ['Heard while silent', e ? `${e.silent.user_segments} (${e.silent.user_finals} final)` : 'n/a', e ? tone(e.silent.user_segments === 0, e.silent.user_finals === 0) : undefined],
              ['She cut herself off', fmt(e?.silent.agent_interruptions), e ? tone(e.silent.agent_interruptions === 0) : undefined],
              ['What it heard', e?.silent.user_texts.length ? e.silent.user_texts.join(' | ') : 'nothing'],
              ['Mic level while she spoke', e?.silent.mic ? `${e.silent.mic.p50_db} dB typical, ${e.silent.mic.p95_db} dB loud` : 'n/a'],
              ['She stopped when talked over', fmt(e?.barge.agent_stopped), e ? tone(e.barge.agent_stopped) : undefined],
              [
                'Stop time after you spoke',
                e?.barge.stop_after_onset_ms != null ? `${e.barge.stop_after_onset_ms} ms (from ${fmt(e.barge.onset_source)})` : 'n/a',
                e?.barge.stop_after_onset_ms != null ? tone(e.barge.stop_after_onset_ms < 800, e.barge.stop_after_onset_ms < 1500) : undefined,
              ],
              ['Her audio quiet after', fmt(e?.barge.audio_stop_after_onset_ms, ' ms')],
            ]}
          />
        )}
      </Step>

      <Step n={7} test="results" title="Send the results" hint="Add anything you noticed, then send. Copy also works if sending fails.">
        <div class="field">
          <label for="diag-note">Notes</label>
          <textarea
            id="diag-note"
            rows={4}
            maxLength={4000}
            value={note}
            onInput={(ev) => setNote(ev.currentTarget.value)}
            placeholder="Room light, where you sat, anything odd you saw or heard."
            data-test="diag-note"
          />
        </div>
        <div class="row">
          <button class="btn btn-primary btn-big" data-test="diag-send" onClick={() => void send()}>
            Send results
          </button>
          <button class="btn btn-big" data-test="diag-copy" onClick={() => void copy()}>
            Copy results
          </button>
        </div>
        {sent && (
          <p class="meta" aria-live="polite" data-test="diag-sent">
            {sent}
          </p>
        )}
        <details class="diag-json">
          <summary>Show the results</summary>
          <pre>{json}</pre>
        </details>
      </Step>
      <div class="diag-stage" ref={stage} aria-hidden="true" />
    </Page>
  );
}

export default Diag;
