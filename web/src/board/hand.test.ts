import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import type { BoardOp } from '../shared/types';
import { HandAdapter, TRACKING_GRACE_MS } from './hand';
import type { BoardPoint } from './input';
import { BoardInput } from './input';
import { HLD_KIT } from './kits';
import { emptyBoard } from './model';
import { BoardStore } from './ops';
import { placeAnchor, SheetProjector, sheetToWorld } from './sheetMath';
import { along } from './testkit';
import { FakePort } from './xrtestkit';

function collect(adapter: HandAdapter) {
  const ev: [string, BoardPoint][] = [];
  adapter.onDown((p) => ev.push(['down', p]));
  adapter.onMove((p) => ev.push(['move', p]));
  adapter.onUp((p) => ev.push(['up', p]));
  adapter.onCancel((p) => ev.push(['cancel', p]));
  return ev;
}

describe('sheet projection', () => {
  it.each([
    ['facing -Z', 0],
    ['turned 30 degrees', Math.PI / 6],
    ['turned -100 degrees', (-100 * Math.PI) / 180],
  ])('pinch_projects_onto_tilted_sheet (%s)', (_name, yaw) => {
    const port = new FakePort({ origin: { x: 0.3, y: 0.74, z: -0.4 }, yaw, deskY: 0.74 });
    const proj = new SheetProjector(port.sheetAnchor);
    // A pinch 2 cm above the sheet centre, along the tilted surface normal.
    const p = sheetToWorld(port.sheetAnchor, 32, 20, 2);
    const b = proj.project(p);
    expect(Math.abs(b.x_cm - 32)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(b.y_cm - 20)).toBeLessThanOrEqual(0.5);
    expect(b.h_cm).toBeCloseTo(2, 3);
    // And through the adapter: a pinch there goes down at (32, 20).
    const hands = new HandAdapter(port, (q) => proj.project(q));
    const ev = collect(hands);
    port.setHand('right', p);
    port.frame();
    port.select('right', 'start');
    const down = ev.find((e) => e[0] === 'down')![1];
    expect(Math.abs(down.x_cm - 32)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(down.y_cm - 20)).toBeLessThanOrEqual(0.5);
    expect(down.hand).toBe('right');
  });

  it('the sheet is tilted 15 degrees, far edge up, near edge 2 cm above the desk', () => {
    const anchor = new Object3D();
    placeAnchor(anchor, { origin: { x: 0, y: 0.74, z: -0.2 }, yaw: 0, deskY: 0.74 });
    const near = sheetToWorld(anchor, 32, 40, 0);
    const far = sheetToWorld(anchor, 32, 0, 0);
    expect(near.y).toBeCloseTo(0.76, 4);
    expect(near.z).toBeCloseTo(-0.2, 4);
    const rise = far.y - near.y;
    const run = near.z - far.z;
    expect((Math.atan2(rise, run) * 180) / Math.PI).toBeCloseTo(15, 3);
    expect(Math.hypot(rise, run)).toBeCloseTo(0.4, 4);
    // x right: board x 64 is 32 cm to the right of the centre line.
    expect(sheetToWorld(anchor, 64, 40, 0).x).toBeCloseTo(0.32, 4);
  });
});

describe('HandAdapter', () => {
  it('ignores a pinch far above the sheet or outside the zone', () => {
    const port = new FakePort();
    const proj = new SheetProjector(port.sheetAnchor);
    const hands = new HandAdapter(port, (q) => proj.project(q), { zone: HLD_KIT.view });
    const ev = collect(hands);
    port.handAt('left', 32, 20, 20);
    port.frame();
    port.select('left', 'start');
    port.select('left', 'end');
    port.handAt('left', 120, 20, 1);
    port.frame();
    port.select('left', 'start');
    expect(ev.filter((e) => e[0] === 'down')).toEqual([]);
  });

  it('hovers inside the zone and moves while pinched even when lifted', () => {
    const port = new FakePort();
    const proj = new SheetProjector(port.sheetAnchor);
    const hands = new HandAdapter(port, (q) => proj.project(q), { zone: HLD_KIT.view });
    const ev = collect(hands);
    port.handAt('right', 10, 10, 3);
    port.frame();
    expect(ev.map((e) => e[0])).toEqual(['move']);
    expect(hands.pointers()).toHaveLength(1);
    port.select('right', 'start');
    port.handAt('right', 12, 10, 14);
    port.frame();
    port.select('right', 'end');
    expect(ev.map((e) => e[0])).toEqual(['move', 'down', 'move', 'up']);
  });

  it('smooths jitter with a One Euro filter (held still, the points barely move)', () => {
    const port = new FakePort();
    const proj = new SheetProjector(port.sheetAnchor);
    const hands = new HandAdapter(port, (q) => proj.project(q));
    const ev = collect(hands);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const centre = sheetToWorld(port.sheetAnchor, 32, 20, 1);
    for (let i = 0; i < 120; i++) {
      port.setHand('right', { x: centre.x + rnd() * 0.004, y: centre.y + rnd() * 0.004, z: centre.z + rnd() * 0.004 });
      port.frame();
    }
    const xs = ev.slice(20).map((e) => e[1].x_cm);
    const spread = Math.max(...xs) - Math.min(...xs);
    // Raw spread is about 0.8 cm.
    expect(spread).toBeLessThan(0.5);
  });

  function dragSetup() {
    const port = new FakePort();
    const proj = new SheetProjector(port.sheetAnchor);
    const hands = new HandAdapter(port, (q) => proj.project(q), { zone: HLD_KIT.view });
    const store = new BoardStore(emptyBoard());
    store.apply({ op_id: 's1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'db', label: null, x: 10, y: 10, w: 8, h: 5 } });
    const emitted: BoardOp[] = [];
    new BoardInput(store, hands, HLD_KIT, (op) => {
      emitted.push(op);
      store.apply(op, { local: true });
    });
    const at = (x: number, y: number, frames = 1) => {
      for (let i = 0; i < frames; i++) {
        port.handAt('right', x, y);
        port.frame();
      }
    };
    return { port, hands, store, emitted, at };
  }

  it('tracking_loss_grace_keeps_drag: a 200 ms loss mid drag continues the drag', () => {
    const { port, emitted, at } = dragSetup();
    at(14, 12.5, 3);
    port.select('right', 'start');
    for (const [x, y] of along([[14, 12.5], [20, 14]], 0.4)) at(x, y);
    // Lost for about 200 ms (no joints), then back with the pinch still held.
    for (let i = 0; i < 14; i++) {
      port.setHand('right', null);
      port.frame();
    }
    for (const [x, y] of along([[20, 14], [30, 19.8]], 0.4)) at(x, y);
    at(30, 19.8, 40);
    port.select('right', 'end');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ op: 'item.move', args: { id: 'n1', x: 26, y: 17 } });
  });

  it('tracking lost past the grace drops the gesture with no op, and the card stays', () => {
    const { port, emitted, at, store } = dragSetup();
    at(14, 12.5, 3);
    port.select('right', 'start');
    for (const [x, y] of along([[14, 12.5], [24, 14]], 0.4)) at(x, y);
    const lostFrames = Math.ceil(TRACKING_GRACE_MS / 14) + 3;
    for (let i = 0; i < lostFrames; i++) {
      port.setHand('right', null);
      port.frame();
    }
    // Tracking comes back far away with the pinch still held, then lets go: nothing happens.
    at(50, 30, 5);
    port.select('right', 'end');
    expect(emitted).toEqual([]);
    expect(store.board.items[0]).toMatchObject({ x: 10, y: 10 });
  });

  it('a release while tracking is lost (within the grace) ends at the last good point', () => {
    const { port, emitted, at } = dragSetup();
    at(14, 12.5, 3);
    port.select('right', 'start');
    for (const [x, y] of along([[14, 12.5], [24, 12.5]], 0.4)) at(x, y);
    at(24, 12.5, 40);
    port.setHand('right', null);
    port.frame();
    port.select('right', 'end');
    expect(emitted[0]).toMatchObject({ op: 'item.move', args: { id: 'n1', x: 20, y: 10 } });
  });

  it('a pinch starts where the hand is now, not where the filter still lags', () => {
    const port = new FakePort();
    const proj = new SheetProjector(port.sheetAnchor);
    const hands = new HandAdapter(port, (q) => proj.project(q), { zone: HLD_KIT.view });
    const ev = collect(hands);
    // Hover far away, then arrive fast at (20, 20) in two frames and pinch at once.
    for (let i = 0; i < 10; i++) {
      port.handAt('right', 50, 20, 2);
      port.frame(50);
    }
    port.handAt('right', 35, 20, 2);
    port.frame(50);
    port.handAt('right', 20, 20, 2);
    port.frame(50);
    port.select('right', 'start');
    const down = ev.find((e) => e[0] === 'down')![1];
    expect(Math.abs(down.x_cm - 20)).toBeLessThan(0.3);
  });

  it('keeps both hands apart', () => {
    const port = new FakePort();
    const proj = new SheetProjector(port.sheetAnchor);
    const hands = new HandAdapter(port, (q) => proj.project(q));
    const ev = collect(hands);
    port.handAt('left', 10, 10);
    port.handAt('right', 50, 30);
    port.frame();
    port.select('left', 'start');
    port.select('right', 'start');
    const downs = ev.filter((e) => e[0] === 'down').map((e) => [e[1].hand, Math.round(e[1].x_cm)]);
    expect(downs).toEqual([['left', 10], ['right', 50]]);
  });

  it('stops after destroy', () => {
    const port = new FakePort();
    const proj = new SheetProjector(port.sheetAnchor);
    const hands = new HandAdapter(port, (q) => proj.project(q));
    const ev = collect(hands);
    hands.destroy();
    port.handAt('left', 10, 10);
    port.frame();
    port.select('left', 'start');
    expect(ev).toEqual([]);
  });
});
