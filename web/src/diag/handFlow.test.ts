import { describe, expect, it, vi } from 'vitest';
import { DONE_BOX, HandFlow, HOLD_AT, HOLD_MS, HOLD_SETTLE_MS, LINE_FROM, LINE_TO, SKIP_BOX, TARGETS } from './handFlow';

const skipPoint = { x: SKIP_BOX.x + SKIP_BOX.w / 2, y: SKIP_BOX.y + SKIP_BOX.h / 2 };

/** A held pinch with a small wobble in the raw point and less in the filtered one. */
function hold(f: HandFlow, t0: number, ms = HOLD_SETTLE_MS + HOLD_MS + 20) {
  f.down(HOLD_AT, t0);
  for (let t = t0; t <= t0 + ms; t += 14) {
    const k = Math.sin(t);
    f.raw({ x: HOLD_AT.x + 0.3 * k, y: HOLD_AT.y }, t);
    f.move({ x: HOLD_AT.x + 0.1 * k, y: HOLD_AT.y }, t);
    f.tick(t);
  }
}

function drawLine(f: HandFlow, t0: number, to = LINE_TO) {
  f.down(LINE_FROM, t0);
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const p = { x: LINE_FROM.x + ((to.x - LINE_FROM.x) * i) / steps, y: LINE_FROM.y + ((to.y - LINE_FROM.y) * i) / steps };
    f.raw({ x: p.x, y: p.y + (i % 2 ? 0.2 : -0.2) }, t0 + i * 14);
    f.move(p, t0 + i * 14);
  }
  f.up(to, t0 + 400);
}

function tapAll(f: HandFlow, t0: number, offset = { x: 0.5, y: 0 }) {
  TARGETS.forEach((t, i) => {
    const at = { x: t.x + offset.x, y: t.y + offset.y };
    f.down(at, t0 + i * 500);
    f.up(at, t0 + i * 500 + 150);
  });
}

describe('HandFlow', () => {
  it('runs hold, line and taps, then Done exits', () => {
    const exit = vi.fn();
    const f = new HandFlow(exit);
    hold(f, 1000);
    expect(f.stage).toBe('line');
    // The up of the finished hold changes nothing.
    f.up(HOLD_AT, 5000);
    expect(f.stage).toBe('line');
    drawLine(f, 6000);
    expect(f.stage).toBe('targets');
    tapAll(f, 8000);
    expect(f.stage).toBe('done');
    const centre = { x: DONE_BOX.x + DONE_BOX.w / 2, y: DONE_BOX.y + DONE_BOX.h / 2 };
    f.down(centre, 12000);
    f.up(centre, 12100);
    expect(exit).toHaveBeenCalledOnce();

    const r = f.results();
    expect(r.hold.tries).toBe(1);
    expect(r.hold.filtered!.rms_cm).toBeGreaterThan(0.03);
    expect(r.hold.filtered!.rms_cm).toBeLessThan(r.hold.raw!.rms_cm);
    expect(r.hold.raw!.rms_cm).toBeCloseTo(0.21, 1);
    expect(r.line.filtered!.rms_cm).toBe(0);
    expect(r.line.filtered!.length_cm).toBe(10);
    expect(r.line.raw!.rms_cm).toBeCloseTo(0.2, 1);
    expect(r.targets.stats).toMatchObject({ taps: 5, hits: 5, rate: 1, mean_dx_cm: 0.5, mean_dy_cm: 0 });
    expect(r.targets.taps.map((t) => t.ms)).toEqual([150, 150, 150, 150, 150]);
    expect(r.gestures).toBe(1 + 1 + 5 + 1);
  });

  it('a hold let go early counts a try and stays on the hold', () => {
    const f = new HandFlow();
    hold(f, 0, 1000);
    f.up(HOLD_AT, 1000);
    expect(f.stage).toBe('hold');
    expect(f.message).toMatch(/too early/);
    hold(f, 2000);
    expect(f.stage).toBe('line');
    expect(f.results().hold.tries).toBe(2);
  });

  it('a hold must start on the dot', () => {
    const f = new HandFlow();
    f.down({ x: 5, y: 5 }, 0);
    for (let t = 0; t < 4000; t += 14) f.tick(t);
    expect(f.stage).toBe('hold');
    expect(f.message).toMatch(/on the dot/);
  });

  it('a short line is retried', () => {
    const f = new HandFlow();
    hold(f, 0);
    drawLine(f, 5000, { x: LINE_FROM.x + 2, y: LINE_FROM.y });
    expect(f.stage).toBe('line');
    expect(f.message).toMatch(/Too short/);
    drawLine(f, 7000);
    expect(f.stage).toBe('targets');
    expect(f.results().line.tries).toBe(2);
  });

  it('misses and offsets show in the tap stats', () => {
    const f = new HandFlow();
    hold(f, 0);
    drawLine(f, 5000);
    tapAll(f, 7000, { x: 0, y: 3 });
    const s = f.results().targets.stats!;
    expect(s.hits).toBe(0);
    expect(s.mean_dy_cm).toBe(3);
  });

  it('Skip moves on and marks the stage skipped', () => {
    const f = new HandFlow();
    f.down(skipPoint, 0);
    f.up(skipPoint, 100);
    expect(f.stage).toBe('line');
    f.down(skipPoint, 200);
    f.up(skipPoint, 300);
    expect(f.stage).toBe('targets');
    TARGETS.slice(0, 2).forEach((t, i) => {
      f.down(t, 400 + i * 100);
      f.up(t, 450 + i * 100);
    });
    f.down(skipPoint, 1000);
    f.up(skipPoint, 1100);
    expect(f.stage).toBe('done');
    const r = f.results();
    expect(r.hold.skipped && r.line.skipped && r.targets.skipped).toBe(true);
    expect(r.targets.stats!.taps).toBe(2);
  });

  it('a lost hand cancels the gesture and counts', () => {
    const f = new HandFlow();
    f.down(HOLD_AT, 0);
    f.cancel();
    expect(f.stage).toBe('hold');
    expect(f.message).toMatch(/lost/);
    expect(f.results()).toMatchObject({ lost: 1, hold: { tries: 1 } });
  });

  it('hold progress runs from 0 to 1 after the settle time', () => {
    const f = new HandFlow();
    f.down(HOLD_AT, 0);
    expect(f.holdProgress(HOLD_SETTLE_MS)).toBe(0);
    expect(f.holdProgress(HOLD_SETTLE_MS + HOLD_MS / 2)).toBeCloseTo(0.5, 6);
    expect(f.holdProgress(10000)).toBe(1);
  });

  it('a controller does the same steps, and its line is the controller draw test next to the pinch one', () => {
    const f = new HandFlow();
    f.setInput('controllers');
    expect(f.message).toBe('Point at the dot, pull the trigger and hold still for 3 seconds.');
    // Hold with the trigger.
    f.down(HOLD_AT, 0, 'controller', true);
    for (let t = 0; t <= HOLD_SETTLE_MS + HOLD_MS + 20; t += 14) {
      f.move(HOLD_AT, t);
      f.tick(t);
    }
    expect(f.stage).toBe('line');
    expect(f.message).toMatch(/Pull the trigger on the left dot/);
    // A line by ray: too short first, then a good one.
    f.down(LINE_FROM, 5000, 'controller', true);
    f.move({ x: LINE_FROM.x + 1, y: LINE_FROM.y }, 5014);
    f.up({ x: LINE_FROM.x + 1, y: LINE_FROM.y }, 5100);
    expect(f.message).toMatch(/Too short\. Hold the trigger/);
    f.down(LINE_FROM, 6000, 'controller', true);
    for (let i = 1; i <= 20; i++) f.move({ x: LINE_FROM.x + (LINE_TO.x - LINE_FROM.x) * (i / 20), y: LINE_FROM.y }, 6000 + i * 14);
    f.up(LINE_TO, 6400);
    expect(f.stage).toBe('targets');
    const r = f.results();
    expect(r.controller_line.mode).toBe('ray');
    expect(r.controller_line.tries).toBe(2);
    expect(r.controller_line.filtered!.length_cm).toBeCloseTo(10, 1);
    expect(r.controller_line.filtered!.rms_cm).toBeLessThan(0.05);
    // The pinch line is untouched: nobody pinched one.
    expect(r.line).toMatchObject({ filtered: null, raw: null, tries: 0 });
    expect(r.by).toEqual({ hold: 'controller', line: 'controller', targets: null });
    // The user puts the controllers down: the next step is worded for hands, and a pinch does it.
    f.setInput('hands');
    expect(f.message).toMatch(/quick pinch/);
    tapAll(f, 8000);
    expect(f.results().by.targets).toBe('hand');
    expect(f.message).toBe('All done. Pinch Done to go back to the page.');
  });

  it('a line drawn by touch with a controller is recorded as touch, and a lost controller says so', () => {
    const f = new HandFlow();
    f.down(skipPoint, 0, 'controller');
    f.up(skipPoint, 100);
    f.down(LINE_FROM, 1000, 'controller', false);
    f.cancel();
    expect(f.message).toBe('The controller was lost. Try again.');
    expect(f.results().controller_line.tries).toBe(1);
    drawLineBy(f, 2000);
    expect(f.results().controller_line).toMatchObject({ mode: 'touch', tries: 2 });
  });
});

function drawLineBy(f: HandFlow, t0: number) {
  f.down(LINE_FROM, t0, 'controller', false);
  for (let i = 1; i <= 20; i++) f.move({ x: LINE_FROM.x + (LINE_TO.x - LINE_FROM.x) * (i / 20), y: LINE_FROM.y }, t0 + i * 14);
  f.up(LINE_TO, t0 + 400);
}
