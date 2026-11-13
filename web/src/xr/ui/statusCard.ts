// Status card: one calm line for what is happening (placing the desk, scoring, paused, reconnecting), with an
// optional progress bar. Stands across the desk at eye level, like the summary card that follows it.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { bar, INK_MUTED, panel, set, show, text, TEXT_BODY } from './style';
import type { StatusStage } from './types';

export const STATUS_WIDTH_CM = 40;

/** Copy per stage: title and detail (plain, short, no dashes). */
export const STATUS_COPY: Record<StatusStage, { title: string; detail: string }> = {
  placing: { title: 'Touch your desk where the sheet should go', detail: 'Rest a fingertip on the desk for a moment.' },
  connecting: { title: 'Joining the room', detail: 'Your interviewer will be with you in a moment.' },
  metrics: { title: 'Writing your scorecard', detail: 'Looking at pace, pauses and talk time.' },
  scoring: { title: 'Writing your scorecard', detail: 'Reading back through the conversation.' },
  done: { title: 'Your scorecard is ready', detail: '' },
  paused: { title: 'Paused', detail: 'Press Resume when you are ready.' },
  error: { title: 'We lost the connection', detail: 'Trying again. Your progress is saved.' },
};

export class StatusCard {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly title;
  private readonly detail;
  private readonly progress;

  constructor() {
    this.group.name = 'status-card';
    const root = panel({ width: STATUS_WIDTH_CM, padding: 2, gap: 1.2, alignItems: 'center' });
    this.title = text('', { fontSize: 2.0, fontWeight: 'semi-bold', textAlign: 'center' });
    this.detail = text('', { fontSize: TEXT_BODY, color: INK_MUTED, textAlign: 'center' });
    this.progress = bar(STATUS_WIDTH_CM - 8);
    root.add(this.title, this.detail, this.progress.root);
    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
  }

  /** Shows a stage; pct (0..1) shows the progress bar, null hides it. */
  set(stage: StatusStage, pct: number | null = null): void {
    const copy = STATUS_COPY[stage];
    this.showText(copy.title, copy.detail, pct);
  }

  showText(title: string, detail = '', pct: number | null = null): void {
    set(this.title, { text: title });
    set(this.detail, { text: detail });
    show(this.detail, detail.length > 0);
    show(this.progress.root, pct !== null);
    if (pct !== null) this.progress.set(pct);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}
