// /dev/board: the board with a mouse, for development and automated screenshots.
// Draw on the sheet, pull cards from the tray, drag a card's tab to connect, drop on the
// bin to delete, type a voice line to label the selected card, undo.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BoardOp } from '../shared/types';
import { parseLabelCommand, voiceLabel } from './grammar';
import { BoardInput } from './input';
import { HLD_KIT } from './kits';
import { COMPONENT_NAMES, emptyBoard, IdGen } from './model';
import { MouseAdapter } from './mouse';
import { BoardStore } from './ops';
import { BoardView } from './render';

const kit = HLD_KIT;

function describe(op: BoardOp, accepted: boolean): string {
  if (!accepted) return 'That change was not allowed.';
  switch (op.op) {
    case 'item.create':
      return op.args.kind === 'component' ? `Added a ${COMPONENT_NAMES[op.args.type].toLowerCase()} card. Say a name for it.` : 'Kept as ink.';
    case 'edge.create':
      return 'Connected.';
    case 'item.move':
      return 'Moved.';
    case 'item.delete':
      return 'Deleted.';
    case 'item.label':
      return `Labelled "${op.args.text ?? ''}".`;
    case 'edge.set_dir':
      return 'Changed the arrow.';
    case 'undo':
      return 'Undone.';
    default:
      return 'Done.';
  }
}

export interface DevBoardHandle {
  store: BoardStore;
  input: BoardInput;
  view: BoardView;
  /** Board cm to viewport (client) pixels, for scripted mouse input. */
  toClient(x: number, y: number): [number, number];
  /** Same path as the text box: a voice line labels the selected card. */
  say(text: string): string;
  /** The board, tray and bin rendered offscreen at `pxPerCm`, as a PNG data URL. */
  snapshot(pxPerCm?: number): string;
}

declare global {
  interface Window {
    __board?: DevBoardHandle;
  }
}

export function DevBoard() {
  const stage = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const api = useRef<DevBoardHandle | null>(null);
  const [status, setStatus] = useState('Draw a box, pull a card from the tray, or draw a line from one card to another.');
  const [rev, setRev] = useState(0);
  const [text, setText] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = stage.current;
    if (!canvas || !host) return;
    const ids = new IdGen('d');
    const store = new BoardStore(emptyBoard({ id: 'dev', question: 'Design a URL shortener' }));
    const view = new BoardView(canvas, {
      pxPerCm: 10,
      originCm: { x: kit.view.x, y: kit.view.y },
      widthCm: kit.view.w,
      heightCm: kit.view.h,
      kit,
      dpr: window.devicePixelRatio || 1,
    });
    const apply = (op: BoardOp) => {
      const r = store.apply(op);
      if (!r.duplicate) setStatus(describe(op, r.accepted));
    };
    const adapter = new MouseAdapter(canvas, (x, y) => view.toBoard(x, y));
    const input = new BoardInput(store, adapter, kit, apply, { ids });

    let frame = 0;
    const paint = () => {
      frame = 0;
      view.draw(store.board, { highlight: input.hover, overlays: input.overlays });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const offStore = store.onChange((b) => {
      setRev(b.rev);
      schedule();
    });
    const offOverlay = input.onOverlay(schedule);

    const fit = () => {
      // The stage has 12 px padding on each side.
      const k = Math.max(4, Math.min((host.clientWidth - 24) / kit.view.w, (host.clientHeight - 24) / kit.view.h));
      view.configure({ pxPerCm: k, dpr: window.devicePixelRatio || 1 });
      canvas.style.width = `${kit.view.w * k}px`;
      canvas.style.height = `${kit.view.h * k}px`;
      schedule();
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(host);
    fit();

    const handle: DevBoardHandle = {
      store,
      input,
      view,
      toClient(x, y) {
        const r = canvas.getBoundingClientRect();
        const [px, py] = view.toPx(x, y);
        return [r.left + px, r.top + py];
      },
      say(line) {
        const hit = voiceLabel(store.board, line);
        let msg: string;
        if (hit) {
          apply({ op_id: ids.next('op'), src: 'voice_grammar', op: 'item.label', args: { id: hit.id, text: hit.label } });
          return `Labelled "${hit.label}".`;
        }
        if (!parseLabelCommand(line)) msg = 'Not a label. Try "call that the order service".';
        else msg = 'Select a card first, then say its name.';
        setStatus(msg);
        return msg;
      },
      snapshot(px = 20) {
        const c = document.createElement('canvas');
        const v = new BoardView(c, { pxPerCm: px, originCm: { x: kit.view.x, y: kit.view.y }, widthCm: kit.view.w, heightCm: kit.view.h, kit });
        v.draw(store.board, { highlight: input.hover, overlays: input.overlays });
        return c.toDataURL('image/png');
      },
    };
    api.current = handle;
    if (import.meta.env.DEV) window.__board = handle;

    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const focus = store.board.focus;
      if ((e.key === 'Delete' || e.key === 'Backspace') && focus) {
        apply({ op_id: ids.next('op'), src: 'hand', op: 'item.delete', args: { id: focus } });
      } else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
        undo();
      }
    };
    const undo = () => {
      const target = store.undoTarget();
      if (target) apply({ op_id: ids.next('op'), src: 'hand', op: 'undo', args: { target_op_id: target } });
      else setStatus('Nothing to undo.');
    };
    undoRef.current = undo;
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      offStore();
      offOverlay();
      input.destroy();
      adapter.destroy();
      if (window.__board === handle) delete window.__board;
    };
  }, []);

  const undoRef = useRef<() => void>(() => {});

  return (
    <div class="devboard" data-test="page-dev-board">
      <style>{CSS}</style>
      <header class="devboard-bar">
        <strong>Board sandbox</strong>
        <form
          class="devboard-say"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            api.current?.say(text);
            setText('');
          }}
        >
          <input
            data-test="voice-input"
            aria-label="Say something"
            placeholder='Say: "call that the order service"'
            value={text}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
          <button class="btn" type="submit" data-test="voice-send">
            Say
          </button>
        </form>
        <button class="btn" type="button" data-test="undo" onClick={() => undoRef.current()}>
          Undo
        </button>
        <span class="devboard-status" data-test="status" aria-live="polite">
          {status} <span class="devboard-rev">rev {rev}</span>
        </span>
      </header>
      <div class="devboard-stage" ref={stage}>
        <canvas ref={canvasRef} data-test="board-canvas" />
      </div>
    </div>
  );
}

export default DevBoard;

const CSS = `
.devboard { position: fixed; inset: 0; z-index: 20; display: flex; flex-direction: column; background: var(--bg, #faf8f5); }
.devboard-bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line, #e7e3dc); flex-wrap: wrap; }
.devboard-say { display: flex; gap: 8px; }
.devboard-say input { width: 320px; max-width: 60vw; padding: 6px 10px; border: 1px solid var(--line, #e7e3dc); border-radius: 8px; font: inherit; }
.devboard-status { color: var(--muted, #6b6760); font-size: 0.9rem; }
.devboard-rev { margin-left: 8px; font-variant-numeric: tabular-nums; opacity: 0.7; }
.devboard-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 12px; }
.devboard-stage canvas { display: block; touch-action: none; cursor: crosshair; border-radius: 6px; }
`;
