// /dev/avatar: a developer page that seats one avatar at a table and drives it by hand or on a loop.
// The test voice plays through a hidden <audio> element; its captured stream drives the lip sync.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { AvatarMode, Mood } from '../types';
import { AvatarDevScene, type DevStatus, type DevView } from './devScene';
import voiceF from './voice-f.wav?url';
import voiceM from './voice-m.wav?url';

declare global {
  interface Window {
    __avatarDev?: AvatarDevScene;
  }
}

const MODES: [AvatarMode, string][] = [
  ['idle', 'Idle'],
  ['listening', 'Listen'],
  ['thinking', 'Think'],
  ['speaking', 'Speak'],
];

const VIEWS: [DevView, string][] = [
  ['seat', 'Seat'],
  ['face', 'Face'],
  ['side', 'Side'],
];

const btn = 'padding:6px 10px;border-radius:8px;border:1px solid #444;background:#1c1b1a;color:#f4f2ee;font:500 13px var(--font);cursor:pointer';

export default function AvatarDev() {
  const host = useRef<HTMLDivElement>(null);
  const [app, setApp] = useState<AvatarDevScene | null>(null);
  const [st, setSt] = useState<DevStatus | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const q = new URLSearchParams(location.search);
    const scene = new AvatarDevScene(host.current, {
      id: q.get('id') ?? 'f01',
      view: (q.get('view') as DevView) ?? 'seat',
      auto: q.get('auto') === '1',
      sway: q.get('sway') === '1',
      mood: (q.get('mood') as Mood) ?? 'warm',
      light: q.get('light') === 'room' ? 'room' : 'dev',
      voiceUrl: (sex) => (sex === 'f' ? voiceF : voiceM),
    });
    window.__avatarDev = scene;
    setApp(scene);
    void scene.load();
    const timer = setInterval(() => setSt({ ...scene.status }), 250);
    return () => {
      clearInterval(timer);
      delete window.__avatarDev;
      scene.dispose();
    };
  }, []);

  return (
    <div data-test="page-dev-avatar" style="position:fixed;inset:0;z-index:50;background:#d9d5ce">
      <div ref={host} style="position:absolute;inset:0" />
      <div style="position:absolute;left:8px;top:8px;display:flex;flex-wrap:wrap;gap:6px;max-width:calc(100% - 16px)">
        {MODES.map(([m, label]) => (
          <button key={m} style={btn} data-test={`mode-${m}`} onClick={() => app?.setMode(m)}>
            {label}
          </button>
        ))}
        <button style={btn} data-test="user-talks" onClick={() => app?.userTalks()}>
          User talks then pauses
        </button>
        <button style={btn} data-test="point" onClick={() => app?.pointAtBoard()}>
          Point at board
        </button>
        {VIEWS.map(([v, label]) => (
          <button key={v} style={btn} data-test={`view-${v}`} onClick={() => app?.setView(v)}>
            {label}
          </button>
        ))}
      </div>
      {st && (
        <div
          data-test="dev-status"
          style="position:absolute;left:8px;bottom:8px;padding:6px 8px;border-radius:8px;background:rgba(20,22,26,.72);color:#f4f2ee;font:12px/1.4 ui-monospace,monospace"
        >
          {st.error ? <div style="color:#ffb4a8">{st.error}</div> : null}
          <div>
            {st.id} {st.ready ? st.mode : 'loading'} | lips {st.engine} | {st.isSpeaking ? 'speaking' : 'quiet'}
            <span
              style={`display:inline-block;vertical-align:middle;margin-left:6px;width:60px;height:6px;background:#555;border-radius:3px;overflow:hidden`}
            >
              <span style={`display:block;height:100%;width:${Math.round(st.voiceLevel * 100)}%;background:#8fd19e`} />
            </span>
          </div>
          <div>
            update {st.updateMeanMs.toFixed(3)} ms (max {st.updateMaxMs.toFixed(3)}) | morph writes {st.morphWrites} |{' '}
            {st.fps} fps | {st.calls} calls | {st.triangles} tris
          </div>
        </div>
      )}
    </div>
  );
}
