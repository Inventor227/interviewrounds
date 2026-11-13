// Development console (shown with ?debug=1): type a turn and press Enter to send it to the
// floor panelist, follow the transcript, and see the latency split of each turn.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ControllerEvents, TranscriptLine } from './controller';
import type { LatencySplit } from './latency';
import type { ControllerState } from './ports';

export interface DevConsoleSource {
  readonly state: ControllerState;
  readonly latencyHistory: readonly LatencySplit[];
  on<K extends keyof ControllerEvents>(event: K, cb: ControllerEvents[K]): () => void;
  sendTypedTurn(text: string): void;
}

const LINES = 6;
const SPLITS = 5;

const box = {
  position: 'fixed',
  left: 'var(--space-4)',
  bottom: 'var(--space-4)',
  width: 'min(420px, calc(100vw - 32px))',
  padding: 'var(--space-3)',
  borderRadius: 'var(--radius)',
  background: 'var(--glass)',
  color: 'var(--glass-ink)',
  font: '13px/1.4 ui-monospace, Menlo, monospace',
  zIndex: 1000,
} as const;

const ms = (v: number | null) => (v === null ? 'n/a' : `${v} ms`);

export function DevConsole({ source }: { source: DevConsoleSource }) {
  const [state, setState] = useState<ControllerState>(source.state);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [splits, setSplits] = useState<LatencySplit[]>(() => source.latencyHistory.slice(-SPLITS));
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offs = [
      source.on('state', setState),
      source.on('latency', () => setSplits(source.latencyHistory.slice(-SPLITS))),
      source.on('transcript', (l) =>
        setLines((prev) => {
          const last = prev.at(-1);
          // Interim and streamed updates of one line replace it.
          const same = last && last.role === l.role && last.panelistId === l.panelistId && !last.final;
          return [...(same ? prev.slice(0, -1) : prev), l].slice(-LINES);
        }),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [source]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    source.sendTypedTurn(t);
    setText('');
  };

  return (
    <div style={box} data-test="dev-console">
      <div data-test="dev-state">Round: {state}</div>
      <ol style={{ margin: '8px 0', paddingLeft: 18 }}>
        {lines.map((l, i) => (
          <li key={i}>
            <b>{l.role === 'user' ? 'You' : l.panelistId}</b>: {l.text}
          </li>
        ))}
      </ol>
      {splits.length > 0 && (
        <table data-test="dev-latency" style={{ width: '100%', marginBottom: 8 }}>
          <thead>
            <tr>
              <th align="left">Turn</th>
              <th align="right">To thinking</th>
              <th align="right">To first words</th>
            </tr>
          </thead>
          <tbody>
            {splits.map((s) => (
              <tr key={s.turn}>
                <td>{s.turn}</td>
                <td align="right">{ms(s.to_thinking_ms)}</td>
                <td align="right">{ms(s.to_first_text_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <input
        ref={input}
        data-test="dev-input"
        value={text}
        placeholder="Type your answer, press Enter"
        aria-label="Typed turn"
        style={{ width: '100%', boxSizing: 'border-box', padding: 6, borderRadius: 8, border: 0 }}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        }}
      />
    </div>
  );
}
