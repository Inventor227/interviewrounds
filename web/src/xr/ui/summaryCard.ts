// Summary card after the round: verdict chip, four competency bars, the top strength, the top fix, then Retry and
// See full report. Stands at eye level across the desk.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import type { Report, VerdictLabel } from '../../shared/types';
import {
  ACCENT,
  AMBER,
  bar,
  BAD,
  button,
  col,
  GLASS_SOLID,
  GOOD,
  INK,
  INK_MUTED,
  panel,
  row,
  set,
  show,
  text,
  TEXT_BODY,
  TEXT_SECONDARY,
  type Button,
} from './style';
import type { RoundAction, SummaryView } from './types';

export const SUMMARY_WIDTH_CM = 50;
const BARS = 4;

const VERDICT_TEXT: Record<VerdictLabel, string> = {
  strong_no_hire: 'Strong no hire',
  no_hire: 'No hire',
  leaning_no_hire: 'Leaning no hire',
  leaning_hire: 'Leaning hire',
  hire: 'Hire',
  strong_hire: 'Strong hire',
};

const TONE_COLOR = { good: GOOD, mid: AMBER, low: BAD } as const;

/** Builds the card's view from a full report (the card shows the first four competencies by weight). */
export function summaryFromReport(r: Report): SummaryView {
  const v = r.headline.verdict;
  const tone = !v ? 'mid' : v.index >= 5 ? 'good' : v.index >= 3 ? 'mid' : 'low';
  const comps = [...r.competencies].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, BARS);
  return {
    verdict: v ? { label: VERDICT_TEXT[v.label], tone, provisional: v.is_provisional } : null,
    note: v ? undefined : r.session.mode === 'meeting' ? 'How the meeting went' : 'Not enough signal yet',
    bars: comps.map((c) => ({ name: c.name, score: c.score })),
    strength: r.strengths[0]?.title ?? null,
    fix: r.weaknesses[0]?.title ?? null,
    canRetry: r.weakest_moment !== null,
  };
}

export class SummaryCard {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly chip;
  private readonly chipText;
  private readonly chipNote;
  private readonly rows: { root: ReturnType<typeof row>; name: ReturnType<typeof text>; bar: ReturnType<typeof bar>; score: ReturnType<typeof text> }[] = [];
  private readonly strength;
  private readonly strengthBox;
  private readonly fix;
  private readonly fixBox;
  private readonly retry: Button;

  constructor(emit: (a: RoundAction) => void) {
    this.group.name = 'summary-card';
    const root = panel({ width: SUMMARY_WIDTH_CM, padding: 2.2, gap: 1.4, backgroundColor: GLASS_SOLID });
    const head = row({ gap: 1.2 });
    this.chip = row({ paddingX: 1.4, paddingY: 0.7, borderRadius: 1.4, backgroundColor: ACCENT });
    this.chipText = text('', { fontSize: 1.8, fontWeight: 'semi-bold' });
    this.chip.add(this.chipText);
    this.chipNote = text('', { fontSize: TEXT_SECONDARY, color: INK_MUTED });
    head.add(this.chip, this.chipNote);
    root.add(head);

    const bars = col({ gap: 0.9, width: '100%' });
    for (let i = 0; i < BARS; i++) {
      const r = row({ gap: 1.2, width: '100%' });
      const name = text('', { fontSize: TEXT_BODY, width: 18, wordBreak: 'keep-all' });
      const b = bar(20);
      const score = text('', { fontSize: TEXT_SECONDARY, color: INK_MUTED, width: 4 });
      r.add(name, b.root, score);
      bars.add(r);
      this.rows.push({ root: r, name, bar: b, score });
    }
    root.add(bars);

    const point = (label: string) => {
      const box = col({ gap: 0.3, width: '100%' });
      const l = text(label, { fontSize: TEXT_SECONDARY, color: INK_MUTED, fontWeight: 'medium' });
      const t = text('', { fontSize: TEXT_BODY, color: INK, lineHeight: '125%' });
      box.add(l, t);
      root.add(box);
      return { box, t };
    };
    const s = point('Keep doing');
    this.strength = s.t;
    this.strengthBox = s.box;
    const f = point('Work on next');
    this.fix = f.t;
    this.fixBox = f.box;

    const actions = row({ gap: 1.5, marginTop: 0.6 });
    this.retry = button('Retry this answer', { width: 21, height: 5, primary: true, onClick: () => emit('retry') });
    const report = button('See full report', { width: 21, height: 5, onClick: () => emit('report') });
    actions.add(this.retry.root, report.root);
    root.add(actions);

    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
  }

  show(v: SummaryView): void {
    if (v.verdict) {
      set(this.chipText, { text: v.verdict.provisional ? `${v.verdict.label} (so far)` : v.verdict.label });
      set(this.chip, { backgroundColor: TONE_COLOR[v.verdict.tone] });
      set(this.chipText, { color: '#14161A' });
    } else {
      set(this.chipText, { text: v.note ?? 'Not enough signal yet', color: INK });
      set(this.chip, { backgroundColor: ACCENT });
    }
    set(this.chipNote, { text: v.verdict?.provisional ? 'Short round' : '' });
    this.rows.forEach((r, i) => {
      const b = v.bars[i];
      show(r.root, !!b);
      if (!b) return;
      set(r.name, { text: b.name });
      r.bar.set(b.score === null ? 0 : b.score / 4);
      set(r.score, { text: b.score === null ? 'n/a' : `${b.score}/4` });
    });
    set(this.strength, { text: v.strength ?? '' });
    show(this.strengthBox, !!v.strength);
    set(this.fix, { text: v.fix ?? '' });
    show(this.fixBox, !!v.fix);
    show(this.retry.root, v.canRetry);
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}
