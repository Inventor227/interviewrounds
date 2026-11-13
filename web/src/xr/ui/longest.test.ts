import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTION_LABELS, NOTICES } from '../../session/notices';
import { BRIEF_MAX_LINES, BRIEF_WIDTH_CM } from './briefCard';
import { STATUS_BUTTON_WIDTHS_CM, STATUS_COPY, STATUS_WIDTH_CM } from './statusCard';
import { TEXT_PRIMARY } from './style';

// Nothing on a card may be cut off at the longest content the app ships. The cards lay their text out with wrapping
// rows (no fixed heights), so what can go wrong is a line with no row, a button label wider than its button, or a
// title that needs more rows than a calm card should have. Checked against every question in content/banks.

const BANKS = path.resolve(__dirname, '../../../../content/banks');
/** Average glyph advance of the UI font as a share of the font size (Inter, mixed text; wide for safety). */
const ADVANCE = 0.6;
const rows = (text: string, fontCm: number, widthCm: number) => Math.ceil((text.length * fontCm * ADVANCE) / widthCm);

interface Card {
  id: string;
  title: string;
  brief_lines?: string[];
}
const cards: Card[] = readdirSync(BANKS)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => (JSON.parse(readFileSync(path.join(BANKS, f), 'utf8')) as { cards: Card[] }).cards);

describe('longest content on the cards', () => {
  it('every_question_card_has_a_row_for_each_of_its_lines', () => {
    expect(cards.length).toBeGreaterThan(20);
    for (const c of cards) expect(c.brief_lines?.length ?? 0, c.id).toBeLessThanOrEqual(BRIEF_MAX_LINES);
  });

  it('the_longest_title_and_lines_wrap_to_at_most_two_rows_on_the_brief_card', () => {
    const inner = BRIEF_WIDTH_CM - 2 * 1.4;
    for (const c of cards) {
      expect(rows(c.title, 1.5, inner), `${c.id} title`).toBeLessThanOrEqual(2);
      for (const l of c.brief_lines ?? []) expect(rows(l, 1.25, inner - 1.35), `${c.id}: ${l}`).toBeLessThanOrEqual(2);
    }
  });

  it('every_status_and_notice_title_fits_two_rows_and_every_button_label_fits_its_button', () => {
    const inner = STATUS_WIDTH_CM - 2 * 1.8;
    const titles = [...Object.values(STATUS_COPY).map((c) => c.title), ...Object.values(NOTICES).map((n) => n.title)];
    for (const t of titles) expect(rows(t, 1.8, inner), t).toBeLessThanOrEqual(2);
    const details = [...Object.values(STATUS_COPY).map((c) => c.detail), ...Object.values(NOTICES).map((n) => n.detail)];
    for (const d of details) expect(rows(d, 1.25, inner), d).toBeLessThanOrEqual(3);
    for (const n of Object.values(NOTICES)) {
      n.actions.forEach((a, i) => {
        const label = ACTION_LABELS[a]!;
        const width = i === 0 ? STATUS_BUTTON_WIDTHS_CM.primary : STATUS_BUTTON_WIDTHS_CM.second;
        expect(label.length * TEXT_PRIMARY * ADVANCE, label).toBeLessThanOrEqual(width - 1);
      });
    }
  });
});
