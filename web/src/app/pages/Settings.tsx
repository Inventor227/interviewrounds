// Settings: defaults for rounds, voice and the room. Each change saves at once
// (PUT /api/me/settings with the whole object). Also the account and "Delete my data".

import { useEffect, useRef, useState } from 'preact/hooks';
import { api, links } from '../../net/api';
import type { Level, Me, Role, Settings as SettingsData, Style } from '../../shared/types';
import { LEVELS, STYLES } from '../../shared/types';
import { loadMe, resetDataCache, setMe, useAsync } from '../components/data';
import { LEVEL_NAMES, STYLE_NAMES } from '../components/format';
import { ErrorState, Loading, Page, Segmented } from '../components/Ui';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function Range(props: {
  id: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  show: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <div class="field">
      <div class="field-head">
        <label for={props.id}>{props.label}</label>
        <output for={props.id} class="num">
          {props.show(v)}
        </output>
      </div>
      {props.hint && <p class="field-hint">{props.hint}</p>}
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={v}
        aria-valuetext={props.show(v)}
        onInput={(e) => setV(Number(e.currentTarget.value))}
        onChange={(e) => props.onCommit(Number(e.currentTarget.value))}
        data-test={`field-${props.id}`}
      />
    </div>
  );
}

function Toggle(props: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div class="field field-toggle">
      <div>
        <label for={props.id}>{props.label}</label>
        {props.hint && <p class="field-hint">{props.hint}</p>}
      </div>
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        class="switch-input"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
        data-test={`field-${props.id}`}
      />
    </div>
  );
}

function Account(props: { me: Me }) {
  const { me } = props;
  if (me.identity.kind === 'user') {
    return (
      <div class="account" data-test="account">
        <p>
          Signed in as <strong>{me.identity.name ?? me.identity.email}</strong>
          {me.identity.name && me.identity.email && <span class="muted"> ({me.identity.email})</span>}
        </p>
        <button
          type="button"
          class="btn btn-small"
          onClick={() => void api.logout().finally(() => (location.href = '/'))}
          data-test="sign-out"
        >
          Sign out
        </button>
      </div>
    );
  }
  return (
    <div class="account" data-test="account">
      <p>You are using a guest pass on this device. Your rounds and settings are saved here.</p>
      {me.sign_in_available && (
        <a class="btn btn-small" href={links.googleSignIn} data-test="sign-in">
          Sign in with Google to keep them on every device
        </a>
      )}
    </div>
  );
}

function DeleteData(props: { onDeleted: () => void }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'error'>('idle');
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (step === 'confirm') {
      opened.current = true;
      box.current?.focus();
    }
    // Back from the confirm ("Keep my data"): focus returns to the button that opened it.
    if (step === 'idle' && opened.current) btn.current?.focus();
  }, [step]);
  if (step === 'idle') {
    return (
      <button type="button" ref={btn} class="btn btn-danger-quiet" onClick={() => setStep('confirm')} data-test="delete-data">
        Delete my data
      </button>
    );
  }
  const go = async () => {
    setStep('busy');
    try {
      await api.deleteMe();
      props.onDeleted();
    } catch {
      setStep('error');
    }
  };
  return (
    <div class="confirm" role="alertdialog" aria-labelledby="del-title" aria-describedby="del-text" tabIndex={-1} ref={box} data-test="delete-confirm">
      <h3 id="del-title">Delete everything?</h3>
      <p id="del-text">
        This removes your rounds, reports, recordings, shared links, streak and settings. It cannot be undone.
      </p>
      {step === 'error' && (
        <p class="bad" role="alert">
          Could not delete. Check your connection and try again.
        </p>
      )}
      <div class="row">
        <button type="button" class="btn btn-danger" disabled={step === 'busy'} onClick={() => void go()} data-test="delete-confirm-yes">
          {step === 'busy' ? 'Deleting' : 'Delete everything'}
        </button>
        <button type="button" class="btn" disabled={step === 'busy'} onClick={() => setStep('idle')} data-test="delete-cancel">
          Keep my data
        </button>
      </div>
    </div>
  );
}

function Form(props: { me: Me }) {
  const [s, setS] = useState<SettingsData>(props.me.settings);
  const [save, setSave] = useState<SaveState>('idle');
  const latest = useRef(s);
  const seq = useRef(0);
  const [deleted, setDeleted] = useState(false);

  const commit = async (next: SettingsData) => {
    latest.current = next;
    setS(next);
    const n = ++seq.current;
    setSave('saving');
    try {
      await api.saveSettings(next);
      if (n !== seq.current) return;
      setMe({ ...props.me, settings: next });
      setSave('saved');
    } catch {
      if (n === seq.current) setSave('error');
    }
  };
  const set = <K extends keyof SettingsData>(k: K, v: SettingsData[K]) => void commit({ ...latest.current, [k]: v });

  if (deleted) {
    return (
      <div class="state" data-test="deleted" role="status">
        <h2>Your data is deleted</h2>
        <p>Everything tied to this device or account is gone. You can start fresh any time.</p>
        <a class="btn btn-primary" href="/">
          Go home
        </a>
      </div>
    );
  }

  return (
    <>
      <p class={`save-state save-${save}`} role="status" aria-live="polite" data-test="save-state" data-state={save}>
        {save === 'saving' && 'Saving'}
        {save === 'saved' && 'Saved'}
        {save === 'error' && (
          <>
            Could not save.{' '}
            <button type="button" class="linklike" onClick={() => void commit(latest.current)} data-test="save-retry">
              Try again
            </button>
          </>
        )}
      </p>

      <section class="set-group" aria-labelledby="g-rounds">
        <h2 id="g-rounds" class="section-title">
          Rounds
        </h2>
        <Segmented<'none' | Role>
          name="default_role"
          legend="Your role"
          value={s.default_role ?? 'none'}
          onChange={(v) => set('default_role', v === 'none' ? null : v)}
          choices={[
            { value: 'none', label: 'Ask each time' },
            { value: 'sde', label: 'Software Engineer' },
            { value: 'pm', label: 'Product Manager' },
          ]}
        />
        <Segmented<Level>
          name="default_level"
          legend="Your level"
          value={s.default_level}
          onChange={(v) => set('default_level', v)}
          choices={LEVELS.map((l) => ({ value: l, label: LEVEL_NAMES[l] }))}
        />
        <Segmented<Style>
          name="default_style"
          legend="Interviewer style"
          value={s.default_style}
          onChange={(v) => set('default_style', v)}
          choices={STYLES.map((v) => ({ value: v, label: STYLE_NAMES[v] }))}
        />
        <Toggle
          id="practice_mode"
          label="Practice mode"
          hint="Interviewers may offer a hint when you are stuck. Hints are noted in the report."
          checked={s.practice_mode}
          onChange={(v) => set('practice_mode', v)}
        />
      </section>

      <section class="set-group" aria-labelledby="g-voice">
        <h2 id="g-voice" class="section-title">
          Voice and sound
        </h2>
        <Range
          id="voice_speed"
          label="Interviewer speed"
          min={0.8}
          max={1.25}
          step={0.05}
          value={s.voice_speed}
          show={(v) => (Math.abs(v - 1) < 0.001 ? 'Normal' : `${v.toFixed(2)}x`)}
          onCommit={(v) => set('voice_speed', v)}
        />
        <Toggle id="captions" label="Captions" hint="Show what the interviewer says as text." checked={s.captions} onChange={(v) => set('captions', v)} />
        <Range
          id="sfx_volume"
          label="Sound effects"
          hint="Soft clicks and paper sounds. Always quiet enough to stay out of your mic."
          min={0}
          max={1}
          step={0.1}
          value={s.sfx_volume}
          show={(v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`)}
          onCommit={(v) => set('sfx_volume', v)}
        />
      </section>

      <section class="set-group" aria-labelledby="g-room">
        <h2 id="g-room" class="section-title">
          In the room
        </h2>
        <Segmented<'right' | 'left'>
          name="dominant_hand"
          legend="Main hand"
          value={s.dominant_hand}
          onChange={(v) => set('dominant_hand', v)}
          choices={[
            { value: 'right', label: 'Right' },
            { value: 'left', label: 'Left' },
          ]}
        />
        <p class="field-hint">The card tray sits on this side of your desk.</p>
        <Range
          id="avatar_brightness"
          label="Interviewer brightness"
          hint="Raise it if people look dim against a bright room."
          min={0.6}
          max={1.2}
          step={0.05}
          value={s.avatar_brightness}
          show={(v) => `${Math.round(v * 100)}%`}
          onCommit={(v) => set('avatar_brightness', v)}
        />
      </section>

      <section class="set-group" aria-labelledby="g-account">
        <h2 id="g-account" class="section-title">
          Account and data
        </h2>
        <Account me={props.me} />
        <DeleteData
          onDeleted={() => {
            resetDataCache();
            setDeleted(true);
          }}
        />
      </section>
    </>
  );
}

export function Settings() {
  const me = useAsync(() => loadMe(), []);
  return (
    <Page test="settings" title="Settings" lede="Your defaults for rounds, voice and the room. Changes save as you go.">
      {me.status === 'loading' && <Loading rows={6} />}
      {me.status === 'error' && <ErrorState error={me.error} onRetry={me.reload} />}
      {me.status === 'ready' && <Form me={me.data} />}
    </Page>
  );
}
