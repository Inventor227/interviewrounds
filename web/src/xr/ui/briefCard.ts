// Brief card: the current question and its requirements, at the sheet's top-left corner. Poke the header to
// collapse it to a small tab and back.

import { UIKit, UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { button, col, INK_MUTED, panel, row, set, show, text, TEXT_SECONDARY, type Button } from './style';

export const BRIEF_WIDTH_CM = 30;
const MAX_LINES = 4;

export class BriefCard {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly question;
  private readonly lines: { row: UIKit.Container; text: UIKit.Text }[] = [];
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
    this.body.add(this.question);
    for (let i = 0; i < MAX_LINES; i++) {
      const r = row({ gap: 0.8, alignItems: 'flex-start', width: '100%' });
      const dot = new UIKit.Container({ width: 0.55, height: 0.55, borderRadius: 0.275, backgroundColor: INK_MUTED, marginTop: 0.55, flexShrink: 0 } as never);
      const t = text('', { fontSize: TEXT_SECONDARY + 0.1, color: INK_MUTED, lineHeight: '125%', flexShrink: 1 });
      r.add(dot, t);
      this.body.add(r);
      this.lines.push({ row: r, text: t });
    }
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
    this.lines.forEach((l, i) => {
      const s = brief.lines[i];
      show(l.row, !!s);
      if (s) set(l.text, { text: s });
    });
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
