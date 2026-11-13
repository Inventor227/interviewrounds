import { describe, expect, it } from 'vitest';
import { DEG, dist, v3 } from '../math';
import { userPoint } from '../seats';
import { BRIEF_MIN_FONT_CM } from './briefCard';
import { CAPTION_MAX_CHARS, CAPTIONS_MIN_FONT_CM, captionLines } from './captions';
import { layoutDesk } from './layout';
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
