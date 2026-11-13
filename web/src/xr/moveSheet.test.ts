import { describe, expect, it } from 'vitest';
import { SLOT } from '../board/kits';
import { SHEET } from '../board/model';
import { MOVE_BAR, MOVE_HOLD_MS, MOVE_LABEL, MOVE_STILL_M, onMoveBar, SheetMove } from './moveSheet';
import type { DeskPose } from './placement';
import { layoutDesk } from './ui/layout';
import { ROUND_BAR_WIDTH_CM } from './ui/roundBar';

const DESK: DeskPose = { origin: { x: 0, y: 0.74, z: -0.4 }, yaw: 0, deskY: 0.74, source: 'fallback', head: { x: 0, y: 1.19, z: -0.2 } };
const AT = { x: -0.23, y: 0.75, z: -0.37 };
const HEAD_Y = 1.19;

describe('moving the sheet by its grab bar', () => {
  it('pinch_and_hold_on_the_bar_then_carry_moves_the_desk', () => {
    const m = new SheetMove();
    m.down('right', AT, 1000, DESK);
    expect(m.update(AT, 1100).state).toBe('arming');
    expect(m.update(AT, 1100).progress).toBeCloseTo(0.2, 5);
    // Held for half a second: the sheet lifts and follows the hand.
    expect(m.update(AT, 1000 + MOVE_HOLD_MS).state).toBe('moving');
    const st = m.update({ x: AT.x + 0.1, y: AT.y - 0.05, z: AT.z - 0.2 }, 1800);
    expect(st.offset.x).toBeCloseTo(0.1, 6);
    expect(st.offset.y).toBeCloseTo(-0.05, 6);
    expect(st.offset.z).toBeCloseTo(-0.2, 6);
    const desk = m.up(HEAD_Y)!;
    expect(desk.origin.x).toBeCloseTo(0.1, 6);
    expect(desk.origin.z).toBeCloseTo(-0.6, 6);
    expect(desk.deskY).toBeCloseTo(0.69, 6);
    expect(desk.origin.y).toBeCloseTo(0.69, 6);
    // It keeps facing the same way and stays the kind of desk it was.
    expect(desk.yaw).toBe(0);
    expect(desk.source).toBe('fallback');
    expect(m.state).toBe('idle');
  });

  it('a_quick_pinch_or_one_that_slides_away_moves_nothing', () => {
    const m = new SheetMove();
    m.down('left', AT, 0, DESK);
    m.update(AT, 200);
    expect(m.up(HEAD_Y)).toBeNull();
    m.down('left', AT, 1000, DESK);
    expect(m.update({ ...AT, x: AT.x + MOVE_STILL_M + 0.005 }, 1200).state).toBe('idle');
    expect(m.update(AT, 2000).state).toBe('idle');
    expect(m.up(HEAD_Y)).toBeNull();
    expect(m.holder).toBeNull();
  });

  it('a_lost_pointer_waits_and_a_cancelled_press_moves_nothing', () => {
    const m = new SheetMove();
    m.down('right', AT, 0, DESK);
    m.update(AT, MOVE_HOLD_MS);
    m.update({ ...AT, x: AT.x + 0.1 }, 700);
    // Tracking drops for a few frames: the sheet stays where it was carried to.
    expect(m.update(null, 750).offset.x).toBeCloseTo(0.1, 6);
    m.cancel();
    expect(m.up(HEAD_Y)).toBeNull();
    expect(m.update(AT, 800).state).toBe('idle');
  });

  it('the_desk_stays_where_a_desk_can_be_below_the_eyes', () => {
    const m = new SheetMove();
    m.down('right', AT, 0, DESK);
    m.update(AT, MOVE_HOLD_MS);
    m.update({ ...AT, y: AT.y + 0.6 }, 700);
    expect(m.up(HEAD_Y)!.deskY).toBeCloseTo(HEAD_Y - 0.25, 6);
    m.down('right', AT, 2000, DESK);
    m.update(AT, 2000 + MOVE_HOLD_MS);
    m.update({ ...AT, y: AT.y - 0.6 }, 2700);
    expect(m.up(HEAD_Y)!.deskY).toBeCloseTo(HEAD_Y - 0.75, 6);
  });

  it('the_bar_is_a_meta_sized_target_clear_of_the_round_bar_the_tray_and_the_sheet', () => {
    // At least 22 mm in its small dimension, with its label at 1 cm.
    expect(MOVE_BAR.d).toBeGreaterThanOrEqual(0.022);
    expect(MOVE_LABEL).toBe('Hold to move');
    // Below the sheet's near edge (z > 0 is toward the user), never on the sheet.
    expect(MOVE_BAR.z - MOVE_BAR.d / 2).toBeGreaterThanOrEqual(0.012);
    expect(onMoveBar({ x: MOVE_BAR.x, y: 0.01, z: MOVE_BAR.z })).toBe(true);
    expect(onMoveBar({ x: MOVE_BAR.x, y: 0.01, z: -0.01 })).toBe(false);
    expect(onMoveBar({ x: MOVE_BAR.x, y: 0.12, z: MOVE_BAR.z })).toBe(false);
    // A ray's hit on the plane counts wherever the controller is.
    expect(onMoveBar({ x: MOVE_BAR.x, y: 0, z: MOVE_BAR.z }, false)).toBe(true);
    // The round bar lies below the near-right edge: its left end is at least 12 mm right of the grab bar.
    const bar = layoutDesk(DESK).roundBar;
    const roundLeft = bar.pos.x - ROUND_BAR_WIDTH_CM / 200;
    expect(roundLeft - (MOVE_BAR.x + MOVE_BAR.w / 2)).toBeGreaterThanOrEqual(0.012);
    // The tray stands beside the sheet (left of x = 0 in board cm), further left than the grab bar's left end.
    const trayRight = (SLOT.x + SLOT.w - SHEET.w / 2) / 100;
    expect(MOVE_BAR.x - MOVE_BAR.w / 2 - trayRight).toBeGreaterThanOrEqual(0.012);
  });
});
