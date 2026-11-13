// Status card: one calm line for what is happening (placing the desk, scoring, paused, reconnecting), with an
// optional progress bar and up to two buttons in its lower half (Resume and End when paused, See history and Stay
// when scoring is slow). After placement it stands on the desk side within direct touch reach (about 0.44 m, below
// the eyes), where the summary card later appears. Every interruption of a round uses this one card.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { bar, button, INK_MUTED, panel, row, set, show, text, type Button } from './style';
import type { RoundAction, StatusStage } from './types';

/** A button on the card: the first one is the primary. */
export interface StatusButton {
  label: string;
  action: RoundAction;
}

/** Gap between the two buttons (Meta: at least 12 mm between touch targets). */
export const STATUS_BUTTON_GAP_CM = 1.6;
const PRIMARY_W = 16;
const SECOND_W = 12;
/** The widest label each button takes at its font size (see readability.test.ts). */
export const STATUS_BUTTON_WIDTHS_CM = { primary: PRIMARY_W, second: SECOND_W };

export const STATUS_WIDTH_CM = 36;
const TITLE_FONT_CM = 1.8;
const DETAIL_FONT_CM = 1.25;
export const STATUS_MIN_FONT_CM = Math.min(TITLE_FONT_CM, DETAIL_FONT_CM);

/** Copy per stage: title and detail (plain, short, no dashes). */
export const STATUS_COPY: Record<StatusStage, { title: string; detail: string }> = {
  placing: { title: 'Touch your desk where the sheet should go', detail: 'Rest a fingertip on the desk for a moment.' },
  connecting: { title: 'Joining the room', detail: 'Your interviewer will be with you in a moment.' },
  metrics: { title: 'Writing your scorecard', detail: 'Looking at pace, pauses and talk time.' },
  scoring: { title: 'Writing your scorecard', detail: 'Reading back through the conversation.' },
  done: { title: 'Your scorecard is ready', detail: '' },
  paused: { title: 'Paused', detail: "Your interviewer will wait. Resume when you're ready." },
  hear: { title: 'Tap to hear your interviewer', detail: 'Your browser may be holding the sound back.' },
  error: { title: 'We lost the connection', detail: 'Trying again. Your progress is saved.' },
};

export class StatusCard {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly title;
  private readonly detail;
  private readonly progress;
  private readonly primary: Button;
  private readonly second: Button;
  private readonly buttons;
  private actions: StatusButton[] = [];
  private shownTitle = '';

  constructor(emit: (a: RoundAction) => void = () => {}) {
    this.group.name = 'status-card';
    const root = panel({ width: STATUS_WIDTH_CM, padding: 1.8, gap: 1.2, alignItems: 'center' });
    this.title = text('', { fontSize: TITLE_FONT_CM, fontWeight: 'semi-bold', textAlign: 'center' });
    this.detail = text('', { fontSize: DETAIL_FONT_CM, color: INK_MUTED, textAlign: 'center' });
    this.progress = bar(STATUS_WIDTH_CM - 8);
    const press = (i: number) => {
      const a = this.actions[i];
      if (a) emit(a.action);
    };
    this.primary = button('Resume', { width: PRIMARY_W, height: 5, primary: true, onClick: () => press(0) });
    this.second = button('End', { width: SECOND_W, height: 5, onClick: () => press(1) });
    this.buttons = row({ gap: STATUS_BUTTON_GAP_CM, justifyContent: 'center' });
    this.buttons.add(this.primary.root, this.second.root);
    root.add(this.title, this.detail, this.progress.root, this.buttons);
    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
    show(this.buttons, false);
  }

  /** Shows a stage; pct (0..1) shows the progress bar, null hides it. Paused shows Resume and End. */
  set(stage: StatusStage, pct: number | null = null): void {
    const copy = STATUS_COPY[stage];
    const actions: StatusButton[] =
      stage === 'paused'
        ? [
            { label: 'Resume', action: 'resume' },
            { label: 'End', action: 'end' },
          ]
        : stage === 'hear'
          ? [{ label: 'Tap to hear', action: 'hear' }]
          : [];
    this.showText(copy.title, copy.detail, pct, actions);
  }

  /** One line, an optional detail and progress bar, and up to two buttons (the first is the primary). */
  showText(title: string, detail = '', pct: number | null = null, actions: StatusButton[] = []): void {
    this.actions = actions.slice(0, 2);
    this.shownTitle = title;
    set(this.title, { text: title });
    set(this.detail, { text: detail });
    show(this.detail, detail.length > 0);
    show(this.progress.root, pct !== null);
    if (pct !== null) this.progress.set(pct);
    const [a, b] = this.actions;
    show(this.buttons, !!a);
    if (a) this.primary.setLabel(a.label);
    show(this.second.root, !!b);
    if (b) this.second.setLabel(b.label);
    this.group.visible = true;
  }

  /** What the card shows now (tests and tooling). */
  get view(): { visible: boolean; title: string; actions: RoundAction[] } {
    return { visible: this.group.visible, title: this.shownTitle, actions: this.actions.map((a) => a.action) };
  }

  hide(): void {
    this.group.visible = false;
  }
}
