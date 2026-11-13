// Round bar: timer, Mute, Pause, captions and End (hold 1 s, a ring fills). Lies below the sheet's near-right edge,
// tilted toward the user, in reach of a poke (research/06 §2.1 and §4).

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { AMBER, button, clock, holdRing, INK, INK_MUTED, panel, set, text, TEXT_SECONDARY, type Button } from './style';
import type { RoundAction, RoundUIState } from './types';

const PAD = 1.2;
const GAP = 1.2;
const W = { timer: 10, mute: 8.5, pause: 8.5, cc: 6, end: 7.5 };
export const ROUND_BAR_WIDTH_CM = W.timer + W.mute + W.pause + W.cc + W.end + GAP * 4 + PAD * 2;
export const END_HOLD_MS = 1000;

export class RoundBar {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly timer;
  private readonly timerOf;
  private readonly mute: Button;
  private readonly pause: Button;
  private readonly cc: Button;
  private readonly end: Button;
  private readonly ring;
  private state: RoundUIState = { status: 'created', elapsed_s: 0, total_s: 0, muted: false, captions: false };
  private shownSecond = -1;
  private holdStart: number | null = null;
  private holdFired = false;
  private now = 0;

  constructor(private readonly emit: (a: RoundAction) => void) {
    this.group.name = 'round-bar';
    const root = panel({ flexDirection: 'row', alignItems: 'center', gap: GAP, padding: PAD, width: ROUND_BAR_WIDTH_CM, borderRadius: 1.8 });
    const tbox = panel({ backgroundColor: 'transparent', padding: 0, gap: 0.1, width: W.timer, alignItems: 'flex-start' });
    this.timer = text('0:00', { fontSize: 2.2, fontWeight: 'semi-bold', color: INK });
    this.timerOf = text('', { fontSize: TEXT_SECONDARY, color: INK_MUTED });
    tbox.add(this.timer, this.timerOf);
    this.mute = button('Mute', { width: W.mute, onClick: () => this.emit(this.state.muted ? 'unmute' : 'mute') });
    this.pause = button('Pause', { width: W.pause, onClick: () => this.emit(this.state.status === 'paused' ? 'resume' : 'pause') });
    this.cc = button('CC', { width: W.cc, onClick: () => this.emit('captions') });
    this.end = button('End', {
      width: W.end,
      onDown: () => this.beginHold(),
      onUp: () => this.cancelHold(),
    });
    root.add(tbox, this.mute.root, this.pause.root, this.cc.root, this.end.root);
    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    // The hold ring sits around the End label, just in front of the panel.
    this.ring = holdRing(0.031, INK);
    this.ring.mesh.position.set((ROUND_BAR_WIDTH_CM / 2 - PAD - W.end / 2) / 100, 0, 0.004);
    this.group.add(this.ring.mesh);
    this.render(true);
  }

  setState(s: RoundUIState): void {
    this.state = { ...s };
    this.render(true);
  }

  setCaptions(on: boolean): void {
    this.state.captions = on;
    this.cc.setOn(on);
  }

  /** dt in seconds; advances the clock while live and drives the hold ring. */
  tick(dt: number, nowMs: number): void {
    this.now = nowMs;
    if (this.state.status === 'live') {
      this.state.elapsed_s += dt;
      this.render(false);
    }
    if (this.holdStart !== null && !this.holdFired) {
      const p = Math.min(1, (nowMs - this.holdStart) / END_HOLD_MS);
      this.ring.set(p);
      if (p >= 1) {
        this.holdFired = true;
        this.emit('end');
      }
    }
  }

  private beginHold(): void {
    this.holdStart = this.now || performance.now();
    this.holdFired = false;
    this.ring.set(0.001);
  }

  private cancelHold(): void {
    this.holdStart = null;
    this.ring.set(0);
  }

  private render(all: boolean): void {
    const s = this.state;
    const sec = Math.floor(s.elapsed_s);
    if (all || sec !== this.shownSecond) {
      this.shownSecond = sec;
      const late = s.total_s > 0 && s.elapsed_s >= s.total_s * 0.8;
      set(this.timer, { text: clock(s.elapsed_s), color: late ? AMBER : INK });
      set(this.timerOf, { text: s.total_s > 0 ? `of ${clock(s.total_s)}` : '' });
    }
    if (!all) return;
    this.mute.setLabel(s.muted ? 'Unmute' : 'Mute');
    this.mute.setOn(s.muted);
    const paused = s.status === 'paused';
    this.pause.setLabel(paused ? 'Resume' : 'Pause');
    this.pause.setOn(paused);
    this.cc.setOn(!!s.captions);
  }
}
