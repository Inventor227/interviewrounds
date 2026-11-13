import { describe, expect, it } from 'vitest';
import { SHEET } from '../board/model';
import { DEMO_BOX, demoAt, LOOP_S, ONBOARD_BEGIN, ONBOARD_COPY, ONBOARD_SKIP, OnboardingView, pointOnBox } from './onboardingView';

describe('the onboarding ghost hand', () => {
  it('loops_in_3_s_or_less_and_draws_the_whole_box_each_time', () => {
    expect(LOOP_S).toBeLessThanOrEqual(3);
    const start = demoAt(0);
    expect(start.drawn).toBe(0);
    expect(start.alpha).toBe(0); // fades in: nothing pops up close to the hand
    let last = 0;
    for (let t = 0; t <= LOOP_S - 0.01; t += 0.05) {
      const d = demoAt(t);
      expect(d.drawn).toBeGreaterThanOrEqual(last);
      last = d.drawn;
    }
    expect(last).toBe(1);
    expect(demoAt(LOOP_S + 0.2)).toEqual(demoAt(0.2)); // and again
  });

  it('the_demonstrated_box_lies_on_the_sheet_and_is_a_comfortable_size', () => {
    const { x0, x1, zFar, zNear } = DEMO_BOX;
    expect(x0).toBeGreaterThan(-SHEET.w / 200);
    expect(x1).toBeLessThan(SHEET.w / 200);
    expect(zFar).toBeGreaterThan(-SHEET.h / 100);
    expect(zNear).toBeLessThan(0);
    expect(x1 - x0).toBeGreaterThanOrEqual(0.1);
    expect(zNear - zFar).toBeGreaterThanOrEqual(0.08);
    expect(pointOnBox(0)).toEqual({ x: x0, z: zFar });
    expect(pointOnBox(1).x).toBeCloseTo(x0, 6);
    expect(pointOnBox(1).z).toBeCloseTo(zFar, 6);
  });

  it('the_copy_is_one_short_line_per_input_and_tells_nobody_to_put_anything_down', () => {
    for (const line of [...Object.values(ONBOARD_COPY), ONBOARD_SKIP, ONBOARD_BEGIN]) expect(line.split(' ').length).toBeLessThanOrEqual(7);
    expect(ONBOARD_COPY.hands).toBe('Pinch and draw a box');
    expect(ONBOARD_COPY.controllers).toBe('Pull the trigger and draw a box');
    expect(JSON.stringify(ONBOARD_COPY)).not.toMatch(/put .*down|say its name/i);
    const v = new OnboardingView();
    expect(v.group.visible).toBe(false);
    expect(v.line).toBeNull();
    v.setInput('controllers');
    v.show(true, 0);
    v.update(1500);
    expect(v.line).toBe('Pull the trigger and draw a box');
    expect(v.group.getObjectByName('ghost-hand')!.visible).toBe(true);
    v.setInput('hands');
    expect(v.line).toBe('Pinch and draw a box');
    v.show(false, 3000);
    expect(v.group.visible).toBe(false);
    v.dispose();
  });
});
