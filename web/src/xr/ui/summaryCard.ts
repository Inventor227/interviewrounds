// Summary card after the round: verdict chip, four competency bars, the top strength, the top fix, then Retry and
// See full report. Stands at eye level across the desk. A few seconds after the round it first shows the quick card
// (one line, the top strength and the top fix, each with the user's own words); the full summary replaces it.

import { UIKitDocument } from '@iwsdk/core';
import { Group } from 'three';
import type { HeadsetCard, Report, VerdictLabel } from '../../shared/types';
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
  type Button,
} from './style';
import type { QuickCardView, RoundAction, SummaryView } from './types';

// Sized for direct touch at about 0.44 m: 1 cm type is 1.3°, buttons 5 cm tall with 1.5 cm between them.
export const SUMMARY_WIDTH_CM = 42;
const BODY_CM = 1.25;
const SMALL_CM = 1.0;
export const SUMMARY_MIN_FONT_CM = SMALL_CM;
export const SUMMARY_BUTTON_GAP_CM = 1.5;
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

/** Longest quote shown under a pick; longer ones are cut at a word. */
export const QUOTE_MAX_CHARS = 90;

function shortQuote(q: string): string {
  const t = q.trim().replace(/\s+/g, ' ');
  if (t.length <= QUOTE_MAX_CHARS) return t;
  const cut = t.slice(0, QUOTE_MAX_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), QUOTE_MAX_CHARS - 20)).trimEnd()}...`;
}

/** Builds the quick card's view from the server's headset card. */
export function quickCardFromHeadset(c: HeadsetCard): QuickCardView {
  const pick = (p: HeadsetCard['top_strength']) => (p ? { title: p.title, quote: p.quote?.trim() ? shortQuote(p.quote) : null } : null);
  return { oneLine: c.one_line, strength: pick(c.top_strength), fix: pick(c.top_fix) };
}

export class SummaryCard {
  readonly group = new Group();
  private readonly doc: UIKitDocument;
  private readonly head;
  private readonly lead;
  private readonly bars;
  private readonly strengthQuote;
  private readonly fixQuote;
  private readonly pending;
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
    const root = panel({ width: SUMMARY_WIDTH_CM, padding: 1.8, gap: 1.1, backgroundColor: GLASS_SOLID });
    const head = row({ gap: 1.2 });
    this.chip = row({ paddingX: 1.4, paddingY: 0.7, borderRadius: 1.4, backgroundColor: ACCENT });
    this.chipText = text('', { fontSize: 1.5, fontWeight: 'semi-bold' });
    this.chip.add(this.chipText);
    this.chipNote = text('', { fontSize: SMALL_CM, color: INK_MUTED });
    head.add(this.chip, this.chipNote);
    this.head = head;
    // The quick card's one line takes the verdict's place until the report is ready.
    this.lead = text('', { fontSize: 1.5, fontWeight: 'semi-bold', lineHeight: '125%', width: '100%' });
    root.add(head, this.lead);
    show(this.lead, false);

    const bars = col({ gap: 0.9, width: '100%' });
    for (let i = 0; i < BARS; i++) {
      const r = row({ gap: 1.2, width: '100%' });
      const name = text('', { fontSize: BODY_CM, width: 15, wordBreak: 'keep-all' });
      const b = bar(15);
      const score = text('', { fontSize: SMALL_CM, color: INK_MUTED, width: 3.5 });
      r.add(name, b.root, score);
      bars.add(r);
      this.rows.push({ root: r, name, bar: b, score });
    }
    root.add(bars);
    this.bars = bars;

    const point = (label: string) => {
      const box = col({ gap: 0.3, width: '100%' });
      const l = text(label, { fontSize: SMALL_CM, color: INK_MUTED, fontWeight: 'medium' });
      const t = text('', { fontSize: BODY_CM, color: INK, lineHeight: '125%' });
      const q = text('', { fontSize: SMALL_CM, color: INK_MUTED, lineHeight: '125%' });
      box.add(l, t, q);
      show(q, false);
      root.add(box);
      return { box, t, q };
    };
    const s = point('Keep doing');
    this.strength = s.t;
    this.strengthBox = s.box;
    this.strengthQuote = s.q;
    const f = point('Work on next');
    this.fix = f.t;
    this.fixBox = f.box;
    this.fixQuote = f.q;
    this.pending = text('Your full scorecard is almost ready.', { fontSize: SMALL_CM, color: INK_MUTED });
    root.add(this.pending);
    show(this.pending, false);

    const actions = row({ gap: SUMMARY_BUTTON_GAP_CM, marginTop: 0.4 });
    this.retry = button('Retry this answer', { width: 18.6, height: 5, fontSize: 1.3, primary: true, onClick: () => emit('retry') });
    const report = button('See full report', { width: 18.6, height: 5, fontSize: 1.3, onClick: () => emit('report') });
    actions.add(this.retry.root, report.root);
    root.add(actions);

    this.doc = new UIKitDocument(root);
    this.group.add(this.doc);
    this.group.visible = false;
  }

  /** The quick card: one line, the top strength and the top fix. See full report already works. */
  showQuick(v: QuickCardView, pending = true): void {
    show(this.head, false);
    show(this.bars, false);
    set(this.lead, { text: v.oneLine });
    show(this.lead, v.oneLine.length > 0);
    const pick = (box: typeof this.strengthBox, t: typeof this.strength, q: typeof this.strengthQuote, p: QuickCardView['strength']) => {
      show(box, !!p);
      set(t, { text: p?.title ?? '' });
      set(q, { text: p?.quote ? `You said: "${p.quote}"` : '' });
      show(q, !!p?.quote);
    };
    pick(this.strengthBox, this.strength, this.strengthQuote, v.strength);
    pick(this.fixBox, this.fix, this.fixQuote, v.fix);
    // "Almost ready" only while the full scorecard is really still on its way.
    show(this.pending, pending && !!(v.strength || v.fix));
    show(this.retry.root, false);
    this.group.visible = true;
  }

  show(v: SummaryView): void {
    show(this.head, true);
    show(this.bars, true);
    show(this.lead, false);
    show(this.pending, false);
    show(this.strengthQuote, false);
    show(this.fixQuote, false);
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
