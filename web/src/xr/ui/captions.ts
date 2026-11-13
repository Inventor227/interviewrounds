// Captions strip (a setting, off by default): who is speaking and their latest words, about 1 m away just below the
// interviewer's chin. Meta caption guidance: a background box, speaker attribution, at most 32 characters per row and
// 2 rows; older words roll off the top as new ones arrive.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { INK_MUTED, panel, set, show, text } from './style';

export const CAPTION_MAX_CHARS = 32;
export const CAPTION_ROWS = 2;
const LINE_FONT_CM = 2.0;
const WHO_FONT_CM = 1.6;
/** Smallest text on the strip (the speaker name), for the readability check. */
export const CAPTIONS_MIN_FONT_CM = Math.min(LINE_FONT_CM, WHO_FONT_CM);
/** 32 characters of 2 cm Inter (about 0.55 em each) plus padding. */
export const CAPTIONS_WIDTH_CM = 40;

/** Wraps words into rows of at most `max` characters (cutting words longer than a row) and keeps the last `rows`. */
export function captionLines(s: string, max = CAPTION_MAX_CHARS, rows = CAPTION_ROWS): string[] {
  const words = s.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let w of words) {
    while (w.length > max) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(w.slice(0, max));
      w = w.slice(max);
    }
    if (!w) continue;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur = `${cur} ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(-rows);
}

export class Captions {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly who;
  private readonly rows;
  private enabled = false;
  private hasText = false;

  constructor() {
    this.group.name = 'captions';
    const root = panel({ width: CAPTIONS_WIDTH_CM, padding: 1.3, gap: 0.3, borderRadius: 1.6 });
    this.who = text('', { fontSize: WHO_FONT_CM, color: INK_MUTED, fontWeight: 'medium' });
    root.add(this.who);
    this.rows = Array.from({ length: CAPTION_ROWS }, () => {
      const t = text('', { fontSize: LINE_FONT_CM, lineHeight: '125%' });
      root.add(t);
      return t;
    });
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

  /** Latest words from a speaker (persona name or "You"), the whole utterance so far; empty clears the strip. */
  setCaption(speaker: string, words: string): void {
    const lines = captionLines(words);
    this.hasText = lines.length > 0;
    set(this.who, { text: speaker });
    this.rows.forEach((r, i) => {
      set(r, { text: lines[i] ?? '' });
      show(r, i < lines.length);
    });
    this.group.visible = this.enabled && this.hasText;
  }
}
