// A one-line hint that shows for a few seconds just below the eye line, e.g. "Put your controllers down; use your
// hands" the first time controllers appear, or "No desk? We set one up for you." after the fallback placement.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import { panel, set, text } from './style';

export const HINT_FONT_CM = 1.5;

export class Hint {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly line;
  private hideAt = 0;

  constructor() {
    this.group.name = 'hint';
    const root = panel({ paddingX: 2, paddingY: 1.1, borderRadius: 2.5, alignItems: 'center' });
    this.line = text('', { fontSize: HINT_FONT_CM, fontWeight: 'medium' });
    root.add(this.line);
    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
  }

  show(line: string, nowMs: number, forMs = 6000): void {
    set(this.line, { text: line });
    this.group.visible = true;
    this.hideAt = nowMs + forMs;
  }

  tick(nowMs: number): void {
    if (this.group.visible && nowMs >= this.hideAt) this.group.visible = false;
  }

  get visible(): boolean {
    return this.group.visible;
  }
}
