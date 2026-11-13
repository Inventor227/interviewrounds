import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Board } from '../shared/types';
import type { Overlay } from './input';
import { HLD_KIT } from './kits';
import { emptyBoard } from './model';
import { SHEET_CANVAS, Sheet } from './sheet';
import { sheetToWorld } from './sheetMath';
import { FakePort, stubCanvas } from './xrtestkit';

function board(): Board {
  return {
    ...emptyBoard(),
    items: [
      { id: 'n1', kind: 'component', type: 'service', label: 'API', x: 4, y: 4, w: 8, h: 5 },
      { id: 'n2', kind: 'component', type: 'db', label: 'Orders', x: 24, y: 4, w: 8, h: 5 },
    ],
  };
}

function setup() {
  const port = new FakePort();
  const sheet = new Sheet({ kit: HLD_KIT, makeCanvas: stubCanvas });
  port.sheetAnchor.add(sheet.group);
  return { port, sheet };
}

const world = (o: { getWorldPosition(v: Vector3): Vector3 }) => o.getWorldPosition(new Vector3());

describe('Sheet', () => {
  it('lies on the sheet frame: its centre is board (32, 20) and it spans 64 x 40 cm', () => {
    const { port, sheet } = setup();
    port.scene.updateMatrixWorld(true);
    const c = world(sheet.boardMesh);
    const want = sheetToWorld(port.sheetAnchor, 32, 20, 0);
    expect(c.distanceTo(new Vector3(want.x, want.y, want.z))).toBeLessThan(1e-6);
    const g = sheet.boardMesh.geometry.parameters;
    expect([g.width, g.height]).toEqual([0.64, 0.4]);
    expect([SHEET_CANVAS.w, SHEET_CANVAS.h]).toEqual([2048, 1280]);
  });

  it('uploads the board texture only when the board changes, not on every gesture frame', () => {
    const { sheet } = setup();
    const b = board();
    sheet.update(b, {});
    expect(sheet.stats.boardUploads).toBe(1);
    sheet.update(b, {});
    expect(sheet.stats.boardUploads).toBe(1);
    for (let i = 0; i < 10; i++) {
      const ink: Overlay = { kind: 'ink', hand: 'right', points: [[40, 30], [40 + i, 31]] };
      sheet.update(b, { overlays: [ink] });
    }
    expect(sheet.stats.boardUploads).toBe(1);
    expect(sheet.stats.gestureUploads).toBe(10);
    sheet.update({ ...b, rev: 1 }, {});
    expect(sheet.stats.boardUploads).toBe(2);
  });

  it('a drag repaints the board once without the card, then only the small gesture mesh moves', () => {
    const { sheet } = setup();
    const b = board();
    sheet.update(b, {});
    const drag = (dx: number): Overlay => ({ kind: 'drag', hand: 'right', id: 'n1', dx, dy: 0, overBin: false, ink: false });
    sheet.update(b, { overlays: [drag(1)] });
    expect(sheet.stats.boardUploads).toBe(2);
    for (let i = 2; i < 8; i++) sheet.update(b, { overlays: [drag(i)] });
    expect(sheet.stats.boardUploads).toBe(2);
    expect(sheet.gestureMesh.visible).toBe(true);
  });

  it('sizes the gesture canvas to what is live, in power-of-two steps up to 1024 px', () => {
    const { sheet } = setup();
    const b = board();
    sheet.update(b, { overlays: [{ kind: 'ink', hand: 'right', points: [[40, 30], [43, 31]] }] });
    const small = sheet.gestureCanvasSize();
    expect(small.w).toBeLessThanOrEqual(256);
    expect(Math.log2(small.w) % 1).toBe(0);
    sheet.update(b, { overlays: [{ kind: 'ink', hand: 'right', points: [[1, 1], [63, 39]] }] });
    const big = sheet.gestureCanvasSize();
    expect(big.w).toBeLessThanOrEqual(1024);
    expect(big.h).toBeLessThanOrEqual(1024);
    sheet.update(b, {});
    expect(sheet.gestureMesh.visible).toBe(false);
  });

  it('shows the pinch shadow while a hand is over the sheet', () => {
    const { sheet } = setup();
    sheet.update(board(), { pointers: [{ hand: 'right', x_cm: 30, y_cm: 30, h_cm: 3, pinched: false }] });
    expect(sheet.gestureMesh.visible).toBe(true);
  });

  it('lights the bin while something is held over it', () => {
    const { sheet } = setup();
    const b = board();
    sheet.update(b, { overlays: [{ kind: 'drag', hand: 'right', id: 'n1', dx: 60, dy: 30, overBin: true, ink: false }] });
    expect(sheet.bin.hot).toBe(true);
    sheet.update(b, {});
    expect(sheet.bin.hot).toBe(false);
  });

  it('puts the tray and the bin beside the sheet, on the kit side', () => {
    const { port, sheet } = setup();
    port.scene.updateMatrixWorld(true);
    const t = world(sheet.tray.mesh);
    const left = sheetToWorld(port.sheetAnchor, 0, 20, 0);
    expect(t.x).toBeLessThan(left.x);
    expect(world(sheet.bin.mesh).x).toBeGreaterThan(sheetToWorld(port.sheetAnchor, 64, 20, 0).x);
  });
});
