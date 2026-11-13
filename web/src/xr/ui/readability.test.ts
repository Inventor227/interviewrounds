import { describe, expect, it } from 'vitest';
import { DEG, dist, v3 } from '../math';
import { seatLayout, SHEET_D, sheetPoint, userPoint } from '../seats';
import { BRIEF_MIN_FONT_CM } from './briefCard';
import { CAPTION_MAX_CHARS, CAPTIONS_MIN_FONT_CM, captionLines } from './captions';
import { layoutBriefBeyondSheet, layoutDesk } from './layout';
import { ROUND_BAR_GAP_CM, ROUND_BAR_MIN_FONT_CM } from './roundBar';
import { STATUS_MIN_FONT_CM } from './statusCard';
import { SUMMARY_BUTTON_GAP_CM, SUMMARY_MIN_FONT_CM } from './summaryCard';

// Meta typography: 14 dp minimum, with 48 dp ≈ 3° → 0.875° for the smallest text on a panel.
const MIN_DEG = 0.875;

describe('readability and reach', () => {
  const desk = { origin: { x: 0, y: 0.74, z: -0.4 }, yaw: 0, deskY: 0.74, head: { x: 0, y: 1.19, z: -0.18 } };
  const eye = v3(desk.head.x, desk.head.y, desk.head.z);
  const poses = layoutDesk(desk);

  const cases: [keyof typeof poses, number][] = [
    ['roundBar', ROUND_BAR_MIN_FONT_CM],
    ['brief', BRIEF_MIN_FONT_CM],
    ['status', STATUS_MIN_FONT_CM],
    ['summary', SUMMARY_MIN_FONT_CM],
    ['captions', CAPTIONS_MIN_FONT_CM],
  ];
  for (const [name, cm] of cases) {
    it(`smallest_text_on_${name}_is_at_least_0_875_deg`, () => {
      const d = dist(eye, poses[name].pos);
      const deg = Math.atan(cm / 100 / d) / DEG;
      expect(deg).toBeGreaterThanOrEqual(MIN_DEG);
    });
  }

  it('the_brief_card_beyond_the_sheet_is_off_the_sheet_and_still_readable', () => {
    const p = layoutBriefBeyondSheet(desk);
    // Beyond the far edge: further from the user than any point of the sheet.
    expect(p.pos.z).toBeLessThan(sheetPoint(desk, 0, SHEET_D, 0).z);
    expect(p.pos.y).toBeGreaterThan(sheetPoint(desk, 0, SHEET_D, 0).y);
    const deg = Math.atan(BRIEF_MIN_FONT_CM / 100 / dist(eye, p.pos)) / DEG;
    expect(deg).toBeGreaterThanOrEqual(MIN_DEG);
    expect(p.tilt).toBeLessThan(0); // leans back
    // Its lower edge (toward the user) is still past the sheet's far edge: nothing on the sheet is covered.
    const lowerEdgeZ = p.pos.z + 0.06 * Math.sin(-p.tilt);
    expect(lowerEdgeZ).toBeLessThan(sheetPoint(desk, 0, SHEET_D, 0).z);
  });

  it('the_brief_card_beyond_the_sheet_stays_low_and_clear_of_every_seat', () => {
    const p = layoutBriefBeyondSheet(desk);
    // Low: its top edge stays well under a seated chest (about 0.3 m above the table).
    const top = p.pos.y + 0.06 * Math.cos(-p.tilt);
    expect(top).toBeLessThan(desk.deskY + 0.23);
    // Seen from the user's eyes, the card's sides stay clear of every panelist's hands (about 0.12 m to each side
    // of the seat's centre line, resting on the table in front of them).
    const side = (x: number, z: number) => Math.atan2(x - eye.x, eye.z - z) / DEG;
    const cardLeft = side(p.pos.x - 0.15, p.pos.z);
    const cardRight = side(p.pos.x + 0.15, p.pos.z);
    for (const n of [1, 2, 3] as const) {
      for (const seat of seatLayout(n, desk)) {
        const handsZ = seat.pos.z + 0.25; // the hands rest about 0.25 m in front of the seat
        const handsLeft = side(seat.pos.x - 0.12, handsZ);
        const handsRight = side(seat.pos.x + 0.12, handsZ);
        const clear = cardRight < handsLeft - 1 || cardLeft > handsRight + 1;
        expect(clear, `seat ${seat.seat} of ${n}: card ${cardLeft.toFixed(1)}..${cardRight.toFixed(1)}, hands ${handsLeft.toFixed(1)}..${handsRight.toFixed(1)}`).toBe(true);
      }
    }
  });

  it('summary_card_buttons_are_in_direct_touch_reach_below_the_eyes', () => {
    const p = poses.summary.pos;
    const d = dist(eye, p);
    expect(d).toBeGreaterThanOrEqual(0.38);
    expect(d).toBeLessThanOrEqual(0.5);
    expect(p.y).toBeLessThan(eye.y - 0.15);
    expect(dist(eye, poses.status.pos)).toBeLessThanOrEqual(0.5);
  });

  it('adjacent_targets_are_at_least_12_mm_apart', () => {
    expect(ROUND_BAR_GAP_CM).toBeGreaterThanOrEqual(1.2);
    expect(SUMMARY_BUTTON_GAP_CM).toBeGreaterThanOrEqual(1.2);
  });

  it('captions_stand_about_1_m_away', () => {
    const d = dist(eye, poses.captions.pos);
    expect(d).toBeGreaterThan(0.85);
    expect(d).toBeLessThan(1.15);
    expect(userPoint(desk).y).toBe(0.74);
  });

  it('captions_wrap_at_32_characters_and_keep_the_last_2_lines', () => {
    const lines = captionLines('Good. Walk me through what happens when a user opens a short link for the first time.');
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    expect(lines.join(' ').endsWith('for the first time.')).toBe(true);
    expect(captionLines('Hello there.')).toEqual(['Hello there.']);
    // A word longer than a line is cut, never overflowing.
    for (const l of captionLines('x'.repeat(70))) expect(l.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
  });
});
