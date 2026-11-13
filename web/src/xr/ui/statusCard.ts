// Status card: one calm line for what is happening (placing the desk, scoring, paused, reconnecting), with an
// optional progress bar and, when paused, a Resume button. After placement it stands on the desk side within direct
// touch reach (about 0.44 m, below the eyes), where the summary card later appears.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { bar, button, INK_MUTED, panel, set, show, text, type Button } from './style';
import type { RoundAction, StatusStage } from './types';

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
  paused: { title: 'Paused', detail: 'Your interviewer will wait. Press Resume when you are ready.' },
  error: { title: 'We lost the connection', detail: 'Trying again. Your progress is saved.' },
};

export class StatusCard {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly title;
  private readonly detail;
  private readonly progress;
  private readonly resume: Button;

  constructor(emit: (a: RoundAction) => void = () => {}) {
    this.group.name = 'status-card';
    const root = panel({ width: STATUS_WIDTH_CM, padding: 1.8, gap: 1.2, alignItems: 'center' });
    this.title = text('', { fontSize: TITLE_FONT_CM, fontWeight: 'semi-bold', textAlign: 'center' });
    this.detail = text('', { fontSize: DETAIL_FONT_CM, color: INK_MUTED, textAlign: 'center' });
    this.progress = bar(STATUS_WIDTH_CM - 8);
    this.resume = button('Resume', { width: 16, height: 5, primary: true, onClick: () => emit('resume') });
    root.add(this.title, this.detail, this.progress.root, this.resume.root);
    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
    show(this.resume.root, false);
  }

  /** Shows a stage; pct (0..1) shows the progress bar, null hides it. Paused shows the Resume button. */
  set(stage: StatusStage, pct: number | null = null): void {
    const copy = STATUS_COPY[stage];
    this.showText(copy.title, copy.detail, pct, stage === 'paused');
  }

  showText(title: string, detail = '', pct: number | null = null, withResume = false): void {
    set(this.title, { text: title });
    set(this.detail, { text: detail });
    show(this.detail, detail.length > 0);
    show(this.progress.root, pct !== null);
    if (pct !== null) this.progress.set(pct);
    show(this.resume.root, withResume);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}
