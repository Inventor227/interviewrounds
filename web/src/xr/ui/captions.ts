// Captions strip (a setting, off by default): who is speaking and their latest words, low across the desk between
// the sheet and the interviewer, so a glance down reads it.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { INK_MUTED, panel, set, text, TEXT_SECONDARY } from './style';

export const CAPTIONS_WIDTH_CM = 62;
/** Keep about two lines at this width. */
const MAX_CHARS = 120;

/** The tail of a caption that fits, cut at a word boundary. */
export function captionTail(s: string, max = MAX_CHARS): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max);
  const sp = cut.indexOf(' ');
  return `…${sp >= 0 ? cut.slice(sp + 1) : cut}`;
}

export class Captions {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly who;
  private readonly line;
  private enabled = false;
  private hasText = false;

  constructor() {
    this.group.name = 'captions';
    const root = panel({ width: CAPTIONS_WIDTH_CM, padding: 1.2, gap: 0.4, borderRadius: 1.6 });
    this.who = text('', { fontSize: TEXT_SECONDARY, color: INK_MUTED, fontWeight: 'medium' });
    this.line = text('', { fontSize: 1.8, lineHeight: '125%' });
    root.add(this.who, this.line);
    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on && this.hasText;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Latest words from a speaker (persona name or "You"); empty text clears the strip. */
  setCaption(speaker: string, words: string): void {
    this.hasText = words.trim().length > 0;
    set(this.who, { text: speaker });
    set(this.line, { text: captionTail(words) });
    this.group.visible = this.enabled && this.hasText;
  }
}
