// The board in XR, wired: hands → ghosts → board input → store, the sheet with its tray and
// bin under the XR app's sheet anchor, the wall mirror, voice labels, and feedback sounds.
// The session code owns the socket: `send` posts board.op, `sendGhostReject` posts
// board.ghost_reject, and server frames go to the same store (apply / confirm / logRejected /
// setGhosts).
import type { BoardOp } from '../shared/types';
import { GhostLayer } from './ghosts';
import { VOICE_FOCUS_MS, voiceLabel, type VoiceLabel } from './grammar';
import { HandAdapter } from './hand';
import { MAX_TEXT_CHARS } from './validate';
import { BoardInput } from './input';
import { HLD_KIT, type Kit } from './kits';
import { IdGen } from './model';
import type { BoardStore } from './ops';
import type { BoardXRPort, Sfx, SfxName } from './port';
import { Sheet } from './sheet';
import { SheetProjector } from './sheetMath';
import { kitFor } from './tray';
import type { MakeCanvas } from './xrmesh';

export interface BoardXROptions {
  store: BoardStore;
  /** Settings dominant_hand: the tray goes on the other side. */
  dominantHand: 'left' | 'right';
  kit?: Kit;
  /** board.op to the server (already applied locally, pending until board.ack). */
  send(op: BoardOp): void;
  /** board.ghost_reject to the server (Scribe ghosts only; local suggestions stay local). */
  sendGhostReject(opId: string): void;
  /**
   * board.focus {item_id}: on every touch or creation of a card (even the same card again,
   * so the server's focus stays fresh), debounced 300 ms. The Scribe resolves "that" with it.
   */
  sendFocus?(itemId: string | null): void;
  sfx?: Sfx;
  makeCanvas?: MakeCanvas;
  ids?: IdGen;
}

export interface BoardXR {
  kit: Kit;
  sheet: Sheet;
  hands: HandAdapter;
  ghosts: GhostLayer;
  input: BoardInput;
  /**
   * A finished user speech segment: labels the fresh focus card, suggests a label, or does
   * nothing. `nowMs` is when it was said (performance.now() timeline; default: now).
   */
  say(text: string, nowMs?: number): VoiceLabel | null;
  destroy(): void;
}

/** The feedback sound for a committed op. */
export function sfxForOp(op: BoardOp): SfxName | null {
  switch (op.op) {
    case 'item.create':
      return op.args.kind === 'ink' ? 'pen' : 'snap';
    case 'item.move':
      return 'snap';
    case 'item.delete':
    case 'edge.delete':
    case 'undo':
      return 'erase';
    case 'edge.create':
    case 'edge.set_dir':
    case 'item.label':
    case 'edge.label':
      return 'click';
    default:
      return null;
  }
}

/** board.focus is sent once the focus has held this long (ms). */
export const FOCUS_DEBOUNCE_MS = 300;

/** At most the server's text limit, by characters. */
const clampText = (t: string) => [...t].slice(0, MAX_TEXT_CHARS).join('');

export function createBoardXR(port: BoardXRPort, opts: BoardXROptions): BoardXR {
  const { store } = opts;
  const kit = kitFor(opts.kit ?? HLD_KIT, opts.dominantHand);
  const ids = opts.ids ?? new IdGen();
  const play = (n: SfxName) => opts.sfx?.play(n);

  // One clock for focus, ghosts and voice: the XR frame time. Registered first so it is
  // current when the hands are read in the same frame.
  let clock = 0;
  const now = () => clock;
  const offClock = port.onFrame((_dt, t) => {
    clock = t;
  });

  const projector = new SheetProjector(port.sheetAnchor);
  const hands = new HandAdapter(port, (p) => projector.project(p), { zone: kit.view });

  const commit = (op: BoardOp): boolean => {
    const r = store.apply(op, { local: true });
    if (!r.accepted) return false;
    opts.send(op);
    const s = sfxForOp(op);
    if (s) play(s);
    return true;
  };

  const ghosts = new GhostLayer(hands, store, kit, {
    now,
    accept: (g) => {
      const local = store.isLocalGhost(g.op_id);
      const ok = commit({ op_id: g.op_id, src: local ? 'voice_grammar' : 'scribe', op: g.op, args: g.args } as BoardOp);
      // A Scribe ghost that no longer applies (its card was deleted, say): tell the server, so
      // it is not offered again.
      if (!ok && !local) opts.sendGhostReject(g.op_id);
    },
    reject: (id) => {
      const local = store.isLocalGhost(id);
      store.rejectGhost(id);
      if (!local) opts.sendGhostReject(id);
      play('erase');
    },
  });
  const input = new BoardInput(store, ghosts, kit, commit, { ids, now });

  const sheet = new Sheet({ kit, makeCanvas: opts.makeCanvas });
  sheet.group.visible = false;
  port.sheetAnchor.add(sheet.group);
  port.wallboardTexture?.(sheet.texture);

  // board.focus: every touch or creation sets the focus (store.focusAt moves even for the same
  // card); send once it has held FOCUS_DEBOUNCE_MS. The starting focus is what the server has.
  let seenFocus = store.board.focus;
  let seenAt = store.focusAt;
  let pendingSince: number | null = null;
  const flushFocus = (t: number) => {
    if (store.board.focus !== seenFocus || store.focusAt !== seenAt) {
      seenFocus = store.board.focus;
      seenAt = store.focusAt;
      pendingSince = t;
    }
    if (pendingSince === null || t - pendingSince < FOCUS_DEBOUNCE_MS) return;
    pendingSince = null;
    opts.sendFocus?.(seenFocus);
  };

  let shown = false;
  const offFrame = port.onFrame((_dt, t) => {
    flushFocus(t);
    const placed = port.desk() !== null;
    if (placed && !shown) {
      shown = true;
      play('flap');
    }
    sheet.group.visible = placed;
    ghosts.update(t);
    sheet.update(store.board, { hovers: input.hovers(), overlays: input.overlays, rings: ghosts.rings(t), pointers: hands.pointers() });
  });

  return {
    kit,
    sheet,
    hands,
    ghosts,
    input,
    // Real time by default: the frame clock stops while the headset is off, and an old focus
    // must not look fresh then (frames use the same performance.now() timeline).
    say(text, t = typeof performance !== 'undefined' ? performance.now() : clock) {
      const hit = voiceLabel(store.board, text, store.freshFocus(t, VOICE_FOCUS_MS));
      if (!hit) return null;
      const args = { id: hit.id, text: clampText(hit.label) };
      if (hit.mode === 'commit') commit({ op_id: ids.next('op'), src: 'voice_grammar', op: 'item.label', args });
      else store.suggest({ op_id: ids.next('op'), src: 'scribe', op: 'item.label', args });
      return hit;
    },
    destroy() {
      offFrame();
      offClock();
      input.destroy();
      ghosts.destroy();
      hands.destroy();
      port.sheetAnchor.remove(sheet.group);
      port.wallboardTexture?.(null);
      sheet.dispose();
    },
  };
}
