// Brief card: the current question and its requirements, at the sheet's top-left corner. Poke the header to
// collapse it to a small tab and back.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { button, col, INK_MUTED, panel, row, set, show, text, TEXT_BODY, TEXT_SECONDARY, type Button } from './style';

export const BRIEF_WIDTH_CM = 30;
const MAX_LINES = 4;

export class BriefCard {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly question;
  private readonly lines;
  private readonly body;
  private readonly heading;
  private readonly toggle: Button;
  private collapsed = false;
  private brief: { question: string; lines: string[] } | null = null;

  constructor() {
    this.group.name = 'brief-card';
    const root = panel({ width: BRIEF_WIDTH_CM, padding: 1.4, gap: 0.8 });
    const head = row({ justifyContent: 'space-between', width: '100%' });
    this.heading = text('Question', { fontSize: TEXT_SECONDARY, color: INK_MUTED, fontWeight: 'medium' });
    this.toggle = button('Hide', { width: 7, height: 4, fontSize: 1.3, onClick: () => this.setCollapsed(!this.collapsed) });
    head.add(this.heading, this.toggle.root);
    this.body = col({ gap: 0.7, width: '100%' });
    this.question = text('', { fontSize: 1.5, fontWeight: 'medium', lineHeight: '125%' });
    this.lines = text('', { fontSize: TEXT_BODY - 0.15, color: INK_MUTED, lineHeight: '130%' });
    this.body.add(this.question, this.lines);
    root.add(head, this.body);
    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
  }

  set(brief: { question: string; lines: string[] } | null | undefined): void {
    if (!brief || !brief.question) {
      this.brief = null;
      this.group.visible = false;
      return;
    }
    if (this.brief && this.brief.question === brief.question && this.brief.lines.join('\n') === brief.lines.join('\n')) return;
    const changed = this.brief?.question !== brief.question;
    this.brief = { question: brief.question, lines: [...brief.lines] };
    set(this.question, { text: brief.question });
    const shown = brief.lines.slice(0, MAX_LINES).map((l) => `• ${l}`);
    set(this.lines, { text: shown.join('\n') });
    show(this.lines, shown.length > 0);
    this.group.visible = true;
    // A new question opens the card again.
    if (changed) this.setCollapsed(false);
  }

  setCollapsed(c: boolean): void {
    this.collapsed = c;
    show(this.body, !c);
    this.toggle.setLabel(c ? 'Show' : 'Hide');
    set(this.heading, { text: c ? 'Brief' : 'Question' });
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }
}
