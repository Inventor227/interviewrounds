// The board in XR, wired: hands → ghosts → board input → store, the sheet with its tray and
// bin under the XR app's sheet anchor, the wall mirror, voice labels, and feedback sounds.
// The session code owns the socket: `send` posts board.op, `sendGhostReject` posts
// board.ghost_reject, and server frames go to the same store (apply / confirm / logRejected /
// setGhosts).
import type { BoardOp } from '../shared/types';
import { GhostLayer } from './ghosts';
import { inferComponentType, VOICE_FOCUS_MS, voiceLabel, type VoiceLabel } from './grammar';
import { HandAdapter } from './hand';
import { MAX_TEXT_CHARS } from './validate';
import { BoardInput, type PointerAdapter } from './input';
import { CodePanel } from './codePanel';
import type { Kit } from './kits';
import { kitForBoard } from './kits/index';
import { findItem, IdGen } from './model';
import type { BoardStore } from './ops';
import type { HapticName } from './pointer';
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
  /**
   * Another pointer instead of the hands: the 2D preview draws with the mouse on a flat view of
   * the same board. The sheet, the wall mirror, ghosts, voice labels and sounds work the same.
   */
  pointer?: PointerAdapter & { destroy(): void };
  /** How long an untouched suggestion waits before it settles by itself (default 4 s; tooling raises it). */
  ghostSettleMs?: number;
}

export interface BoardXR {
  kit: Kit;
  sheet: Sheet;
  /** The code panel (coding rounds), standing beside the sheet on the dominant side. */
  panel: CodePanel | null;
  /** The hand pointer; null when another pointer drives the board (the 2D preview). */
  hands: HandAdapter | null;
  ghosts: GhostLayer;
  input: BoardInput;
  /** Takes back the last thing this user did on the board (a controller's A or X button); false when there is nothing. */
  undo(hand: 'left' | 'right'): boolean;
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

/** The pulse a controller gives for a feedback sound: placements snap, ticks and connections click, the bin erases. */
export function hapticForSfx(name: SfxName): HapticName | null {
  switch (name) {
    case 'snap':
      return 'snap';
    case 'click':
      return 'connect';
    case 'erase':
      return 'bin';
    default:
      return null;
  }
}

/** A pulse goes to the side that acted within this long (ms). */
const ACTOR_FRESH_MS = 500;

/** A thumbstick pushed past this scrolls the code panel... */
export const STICK_SCROLL_AT = 0.6;
/** ...one line at once, then a line every this long while it is held (ms). */
export const STICK_SCROLL_REPEAT_MS = 160;

/** board.focus is sent once the focus has held this long (ms). */
export const FOCUS_DEBOUNCE_MS = 300;

/** At most the server's text limit, by characters. */
const clampText = (t: string) => [...t].slice(0, MAX_TEXT_CHARS).join('');

export function createBoardXR(port: BoardXRPort, opts: BoardXROptions): BoardXR {
  const { store } = opts;
  let clock = 0;
  const kit = kitFor(opts.kit ?? kitForBoard(store.board), opts.dominantHand);
  const ids = opts.ids ?? new IdGen();
  // Sounds are for everyone; a controller also gets a short pulse in the hand that did it: the side that
  // is pressing now or let go a moment ago (a suggestion that settles by itself pulses nobody).
  let actor: 'left' | 'right' | null = null;
  let actorAt = -Infinity;
  const pressing = new Set<'left' | 'right'>();
  /** True while the frame's ghost pass accepts a suggestion nobody touched: that is not the user's doing. */
  let settling = false;
  const play = (n: SfxName) => {
    opts.sfx?.play(n);
    const h = hapticForSfx(n);
    if (h && actor && !settling && (pressing.has(actor) || clock - actorAt <= ACTOR_FRESH_MS)) port.haptic?.(actor, h);
  };

  // One clock for focus, ghosts and voice: the XR frame time. Registered first so it is
  // current when the hands are read in the same frame.
  const now = () => clock;
  const offClock = port.onFrame((_dt, t) => {
    clock = t;
  });

  // Coding: a panel beside the sheet; hands project onto whichever surface they are at.
  const panel = kit.panel ? new CodePanel(kit, kit.panel.x >= SHEET.w / 2 ? 'right' : 'left', opts.makeCanvas) : null;
  if (panel) port.sheetAnchor.add(panel.frame);
  const projector = new SurfaceProjector(port.sheetAnchor, panel && kit.panel ? { frame: panel.frame, rect: kit.panel } : undefined);
  const hands = opts.pointer ? null : new HandAdapter(port, (p) => projector.project(p), { zone: kit.view, cast: (o, d) => projector.cast(o, d) });
  const pointer: PointerAdapter & { destroy(): void } = opts.pointer ?? hands!;

  const commit = (op: BoardOp): boolean => {
    const r = store.apply(op, { local: true });
    if (!r.accepted) return false;
    opts.send(op);
    const s = sfxForOp(op);
    if (s) play(s);
    return true;
  };

  let inGhostPass = false;
  const ghosts = new GhostLayer(pointer, store, kit, {
    now,
    ...(opts.ghostSettleMs ? { settleMs: opts.ghostSettleMs } : {}),
    accept: (g) => {
      const local = store.isLocalGhost(g.op_id);
      settling = inGhostPass;
      const ok = commit({ op_id: g.op_id, src: local ? 'voice_grammar' : 'scribe', op: g.op, args: g.args } as BoardOp);
      // A Scribe ghost that no longer applies (its card was deleted, say): tell the server, so
      // it is not offered again.
      settling = false;
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

  // Who acted last (for the pulse), and a click and a pulse when a press picks something up. Registered after the ghosts
  // and the input, so both have seen the press.
  const offActor = [
    pointer.onDown((p) => {
      if (p.hand === 'mouse') return;
      actor = p.hand;
      actorAt = clock;
      pressing.add(p.hand);
      if (input.holding(p.hand) === 'pick') {
        // A pinch or a trigger that picks something up is heard (a short click) and, on a controller, felt.
        opts.sfx?.play('click');
        port.haptic?.(p.hand, 'press');
      }
    }),
    pointer.onUp((p) => {
      if (p.hand === 'mouse') return;
      actor = p.hand;
      actorAt = clock;
      pressing.delete(p.hand);
    }),
    pointer.onCancel?.((p) => {
      if (p.hand !== 'mouse') pressing.delete(p.hand);
    }) ?? (() => undefined),
  ];

  // Controller extras. A or X takes back the last thing this user did on the board.
  const undo = (hand: 'left' | 'right'): boolean => {
    // Not while either side is in the middle of something (A on one controller must not take back the card the
    // other one is carrying).
    if (input.holding('left') || input.holding('right')) return false;
    const target = store.undoTarget();
    if (!target) return false;
    actor = hand;
    actorAt = clock;
    return commit({ op_id: ids.next('op'), src: 'hand', op: 'undo', args: { target_op_id: target } });
  };
  const offButton = port.onButton?.((hand, button) => {
    if (button === 'primary' && port.desk() !== null) undo(hand);
  });
  // The thumbstick scrolls the code panel: up shows earlier lines.
  let stickAt = 0;
  let stickDir = 0;
  const scrollByStick = (t: number) => {
    if (!kit.panelScroll) return;
    let y = 0;
    for (const c of port.controllers?.() ?? []) if (c.tracked && c.stick && Math.abs(c.stick.y) > Math.abs(y)) y = c.stick.y;
    const dir = Math.abs(y) >= STICK_SCROLL_AT ? Math.sign(y) : 0;
    if (dir === 0) {
      stickDir = 0;
      return;
    }
    if (dir === stickDir && t - stickAt < STICK_SCROLL_REPEAT_MS) return;
    stickDir = dir;
    stickAt = t;
    kit.panelScroll(store.board, dir);
  };

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
    inGhostPass = true;
    ghosts.update(t);
    inGhostPass = false;
    if (placed) scrollByStick(t);
    const overlays = input.overlays;
    sheet.update(store.board, { hovers: input.hovers(), overlays, rings: ghosts.rings(t), pointers: hands?.pointers() ?? [] });
    panel?.update(store.board, overlays);
  });

  return {
    kit,
    sheet,
    panel,
    hands,
    ghosts,
    input,
    undo,
    // Real time by default: the frame clock stops while the headset is off, and an old focus
    // must not look fresh then (frames use the same performance.now() timeline).
    say(text, t = typeof performance !== 'undefined' ? performance.now() : clock) {
      const hit = voiceLabel(store.board, text, store.freshFocus(t, VOICE_FOCUS_MS));
      if (!hit) return null;
      const args = { id: hit.id, text: clampText(hit.label) };
      if (hit.mode === 'commit') {
        // A box drawn by hand starts as a service: its spoken name says what it really is ("call that the seat
        // table" makes it a database). Only while it still has the type its shape gave it; never a tray choice.
        const it = findItem(store.board, hit.id);
        const drawn = input.drawnType(hit.id);
        const type = inferComponentType(hit.label);
        if (it?.kind === 'component' && drawn !== null && it.type === drawn && type && type !== it.type) {
          commit({ op_id: ids.next('op'), src: 'voice_grammar', op: 'item.set_type', args: { id: hit.id, type } });
        }
        commit({ op_id: ids.next('op'), src: 'voice_grammar', op: 'item.label', args });
      }
      else store.suggest({ op_id: ids.next('op'), src: 'scribe', op: 'item.label', args });
      return hit;
    },
    destroy() {
      offFrame();
      offClock();
      offButton?.();
      offActor.forEach((off) => off());
      input.destroy();
      ghosts.destroy();
      pointer.destroy();
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
