import { describe, expect, it } from 'vitest';
import { captionLines } from './captions';
import { layoutDesk } from './layout';
import { clock } from './style';
import { summaryFromReport } from './summaryCard';
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
});
