// Captions strip (a setting, off by default): who is speaking and their latest words, about 1 m away just below the
// interviewer's chin. Meta caption guidance: a background box, speaker attribution, at most 32 characters per row and
// 2 rows; older words roll off the top as new ones arrive.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { col, INK_MUTED, panel, set, show, text } from './style';

export const CAPTION_MAX_CHARS = 32;
export const CAPTION_ROWS = 2;
const LINE_FONT_CM = 2.0;
const WHO_FONT_CM = 1.6;
/** Smallest text on the strip (the speaker name), for the readability check. */
export const CAPTIONS_MIN_FONT_CM = Math.min(LINE_FONT_CM, WHO_FONT_CM);
/** 32 characters of 2 cm Inter, with room for wide glyphs, so a row never wraps to a third line. */
export const CAPTIONS_WIDTH_CM = 46;

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

/** Rows for an utterance spoken in segments: each segment (after a pause) starts a new row; the last 2 rows show. */
export function captionRows(segments: readonly string[], max = CAPTION_MAX_CHARS, rows = CAPTION_ROWS): string[] {
  const all: string[] = [];
  for (const seg of segments) all.push(...captionLines(seg, max, Number.MAX_SAFE_INTEGER));
  return all.slice(-rows);
}

/** A pause this long in an utterance starts a new row. */
export const CAPTION_BREAK_MS = 1500;
/** Rows ease up into place over this long when a new row arrives. */
const ROLL_MS = 500;

export class Captions {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly who;
  private readonly rows;
  private readonly body;
  private enabled = false;
  private hasText = false;
  private speaker = '';
  /** Utterance so far, split where the speaker paused. */
  private segments: string[] = [];
  private lastText = '';
  private lastAt = -Infinity;
  private shown: string[] = [];
  private rollStart: number | null = null;

  constructor() {
    this.group.name = 'captions';
    const root = panel({ width: CAPTIONS_WIDTH_CM, padding: 1.3, gap: 0.3, borderRadius: 1.6 });
    this.who = text('', { fontSize: WHO_FONT_CM, color: INK_MUTED, fontWeight: 'medium' });
    root.add(this.who);
    this.body = col({ gap: 0, width: '100%' });
    this.rows = Array.from({ length: CAPTION_ROWS }, () => {
      const t = text('', { fontSize: LINE_FONT_CM, lineHeight: '125%', wordBreak: 'keep-all' });
      this.body.add(t);
      return t;
    });
    root.add(this.body);
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

  /** The rows on screen now (for tests and tooling). */
  get rowsShown(): string[] {
    return [...this.shown];
  }

  /**
   * Latest words from a speaker (persona name or "You"): the whole utterance so far. A new speaker or a new
   * utterance clears the strip; words added after a 1.5 s pause start a new row. Empty text clears it.
   */
  setCaption(speaker: string, words: string, nowMs = performance.now()): void {
    const text = words.trim().replace(/\s+/g, ' ');
    if (!text) {
      this.segments = [];
    } else if (speaker !== this.speaker || !text.startsWith(this.lastText) || this.segments.length === 0) {
      this.segments = [text];
    } else {
      const added = text.slice(this.lastText.length).trim();
      if (added) {
        if (nowMs - this.lastAt >= CAPTION_BREAK_MS) this.segments.push(added);
        else this.segments[this.segments.length - 1] = `${this.segments[this.segments.length - 1]} ${added}`.trim();
      }
    }
    this.speaker = speaker;
    this.lastText = text;
    this.lastAt = nowMs;
    const lines = captionRows(this.segments);
    // A row scrolled off the top: ease the rows up into place.
    if (this.shown.length === CAPTION_ROWS && lines.length === CAPTION_ROWS && lines[0] !== this.shown[0]) this.rollStart = nowMs;
    this.shown = lines;
    this.hasText = lines.length > 0;
    set(this.who, { text: speaker });
    this.rows.forEach((r, i) => {
      set(r, { text: lines[i] ?? '' });
      show(r, i < lines.length);
    });
    this.group.visible = this.enabled && this.hasText;
  }

  /** Drives the roll-up ease. */
  tick(nowMs: number): void {
    if (this.rollStart === null) return;
    const t = Math.min(1, (nowMs - this.rollStart) / ROLL_MS);
    const e = 1 - Math.pow(1 - t, 3);
    set(this.body, { transformTranslateY: (1 - e) * LINE_FONT_CM * 1.25 });
    if (t >= 1) this.rollStart = null;
  }
}
