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
import { CodePanel } from './codePanel';
import type { Kit } from './kits';
import { kitForBoard } from './kits/index';
import { IdGen } from './model';
import type { BoardStore } from './ops';
import type { BoardXRPort, Sfx, SfxName } from './port';
import { Sheet } from './sheet';
import { SHEET } from './model';
import { SurfaceProjector } from './sheetMath';
import { kitFor } from './tray';
import type { MakeCanvas } from './xrmesh';

export interface BoardXROptions {
  store: BoardStore;
  /** Settings dominant_hand: the tray goes on the other side. */
  dominantHand: 'left' | 'right';
  /** The kit; default: the one for the board's round type (board.round.type). */
  kit?: Kit;
  /** Seconds since round start, for ops that carry a time (code.trace, agenda.check, present.show). */
  now_s?: () => number;
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
  /** The code panel (coding rounds), standing beside the sheet on the dominant side. */
  panel: CodePanel | null;
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
    // Placements and reorders.
    case 'item.move':
    case 'member.move':
    case 'code.move':
    case 'code.indent':
    case 'present.show':
      return 'snap';
    // The bin.
    case 'item.delete':
    case 'edge.delete':
    case 'member.remove':
    case 'code.delete':
    case 'undo':
      return 'erase';
    // Ticks, chips and steps.
    case 'edge.create':
    case 'edge.set_dir':
    case 'edge.set_rel':
    case 'item.label':
    case 'edge.label':
    case 'code.complexity':
    case 'code.trace':
    case 'agenda.check':
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
  const kit = kitFor(opts.kit ?? kitForBoard(store.board), opts.dominantHand);
  const ids = opts.ids ?? new IdGen();
  const play = (n: SfxName) => opts.sfx?.play(n);

  // One clock for focus, ghosts and voice: the XR frame time. Registered first so it is
  // current when the hands are read in the same frame.
  let clock = 0;
  const now = () => clock;
  const offClock = port.onFrame((_dt, t) => {
    clock = t;
  });

  // Coding: a panel beside the sheet; hands project onto whichever surface they are at.
  const panel = kit.panel ? new CodePanel(kit, kit.panel.x >= SHEET.w / 2 ? 'right' : 'left', opts.makeCanvas) : null;
  if (panel) port.sheetAnchor.add(panel.frame);
  const projector = new SurfaceProjector(port.sheetAnchor, panel && kit.panel ? { frame: panel.frame, rect: kit.panel } : undefined);
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
  const input = new BoardInput(store, ghosts, kit, commit, { ids, now, ...(opts.now_s ? { now_s: opts.now_s } : {}) });

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
    if (panel) panel.frame.visible = placed;
    ghosts.update(t);
    const overlays = input.overlays;
    sheet.update(store.board, { hovers: input.hovers(), overlays, rings: ghosts.rings(t), pointers: hands.pointers() });
    panel?.update(store.board, overlays);
  });

  return {
    kit,
    sheet,
    panel,
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
      if (panel) {
        port.sheetAnchor.remove(panel.frame);
        panel.dispose();
      }
      port.wallboardTexture?.(null);
      sheet.dispose();
    },
  };
}
