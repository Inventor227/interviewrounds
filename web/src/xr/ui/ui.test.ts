import { describe, expect, it } from 'vitest';
import { captionLines, captionRows, Captions } from './captions';
import { layoutDesk } from './layout';
import { clock } from './style';
import { QUOTE_MAX_CHARS, quickCardFromHeadset, summaryFromReport } from './summaryCard';
import type { Report } from '../../shared/types';

describe('round ui helpers', () => {
  it('clock_formats_minutes_and_seconds', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(761.9)).toBe('12:41');
  });

  it('captions_roll_older_rows_off_the_top', () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const rows = captionLines(long);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.endsWith('w59')).toBe(true);
    expect(rows.join(' ')).not.toContain('w0 ');
  });

  it('a_pause_of_1_5_s_starts_a_new_caption_row', () => {
    expect(captionRows(['Good.', 'Now tell me about the cache.'])).toEqual(['Good.', 'Now tell me about the cache.']);
    expect(captionLines('Good. Now tell me about the cache.')).toEqual(['Good. Now tell me about the', 'cache.']);
    const c = new Captions();
    c.setEnabled(true);
    c.setCaption('Daniel', 'Good.', 0);
    c.setCaption('Daniel', 'Good. Now tell me', 2000); // 2 s later: new row
    expect(c.rowsShown).toEqual(['Good.', 'Now tell me']);
    c.setCaption('Daniel', 'Good. Now tell me about it', 2300); // continues the same row
    expect(c.rowsShown).toEqual(['Good.', 'Now tell me about it']);
    c.setCaption('Maya', 'Hello', 2400); // new speaker: fresh strip
    expect(c.rowsShown).toEqual(['Hello']);
  });

  it('summary_from_report_takes_top_four_by_weight', () => {
    const r = {
      session: { mode: 'interview' },
      headline: { summary: '', verdict: { label: 'leaning_hire', index: 4, is_provisional: false, confidence: 'medium' } },
      competencies: [1, 2, 3, 4, 5].map((i) => ({ id: `c${i}`, name: `C${i}`, score: i % 4 || 4, rationale: '', evidence_ids: [], weight: i })),
      strengths: [{ title: 'Clear scoping', detail: '', evidence_ids: [] }],
      weaknesses: [],
      weakest_moment: null,
    } as unknown as Report;
    const v = summaryFromReport(r);
    expect(v.verdict).toEqual({ label: 'Leaning hire', tone: 'mid', provisional: false });
    expect(v.bars.map((b) => b.name)).toEqual(['C5', 'C4', 'C3', 'C2']);
    expect(v.strength).toBe('Clear scoping');
    expect(v.fix).toBeNull();
    expect(v.canRetry).toBe(false);
  });

  it('round_bar_sits_below_the_sheet_near_right_edge_tilted_toward_the_user', () => {
    const desk = { origin: { x: 0, y: 0.74, z: -0.4 }, yaw: 0, deskY: 0.74 };
    const p = layoutDesk(desk);
    expect(p.roundBar.pos.x).toBeGreaterThan(0.1);
    expect(p.roundBar.pos.z).toBeGreaterThan(-0.4); // nearer the user than the sheet's near edge
    expect(p.roundBar.tilt).toBeCloseTo((-55 * Math.PI) / 180, 6); // 35° up from the desk
    expect(p.brief.pos.x).toBeLessThan(0);
    expect(p.summary.pos.y).toBeGreaterThan(0.74 + 0.1);
  });

  it('quick_card_keeps_the_line_and_cuts_long_quotes_at_a_word', () => {
    const long = 'so the write path goes through the queue first and then the workers pick it up and store it and after that we ack';
    const v = quickCardFromHeadset({
      one_line: 'Clear on scale, thin on failure cases.',
      top_strength: { title: 'Sized the system first', evidence_id: 'c1', quote: 'about a hundred million a day', t_start_sec: 41 },
      top_fix: { title: 'Name the failure cases', evidence_id: 'c2', quote: long, t_start_sec: 188 },
    });
    expect(v.oneLine).toBe('Clear on scale, thin on failure cases.');
    expect(v.strength).toEqual({ title: 'Sized the system first', quote: 'about a hundred million a day' });
    expect(v.fix!.quote!.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS + 3);
    expect(v.fix!.quote!.endsWith('...')).toBe(true);
    expect(long.startsWith(v.fix!.quote!.slice(0, -3))).toBe(true);
    expect(quickCardFromHeadset({ one_line: 'x', top_strength: null, top_fix: null })).toEqual({ oneLine: 'x', strength: null, fix: null });
  });
});
