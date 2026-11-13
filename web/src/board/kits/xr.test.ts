import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Board, BoardOp } from '../../shared/types';
import { createBoardXR, sfxForOp } from '../boardXR';
import { emptyBoard } from '../model';
import { BoardStore } from '../ops';
import { panelToLocal } from '../sheetMath';
import { FakePort, stubCanvas } from '../xrtestkit';
import { CODE_FONT_CM, codeLineRect } from './coding';

function codingBoard(): Board {
  return {
    ...emptyBoard({ kit: 'coding' }),
    code: {
      language: 'python',
      lines: [
        { id: 'l1', indent: 0, text: 'def total(xs):', src: 'scribe' },
        { id: 'l2', indent: 1, text: 'return sum(xs)', src: 'scribe' },
        { id: 'l3', indent: 1, text: 's = 0', src: 'scribe' },
      ],
      approach: [],
      complexity: { time: null, space: null },
      trace: [],
    },
  };
}

function setup(board: Board, dominantHand: 'left' | 'right' = 'right') {
  const port = new FakePort();
  const store = new BoardStore(board);
  const sent: BoardOp[] = [];
  const xr = createBoardXR(port, { store, dominantHand, send: (op) => sent.push(op), sendGhostReject: () => {}, makeCanvas: stubCanvas });
  port.frame();
  return { port, store, sent, xr };
}

describe('kits in XR', () => {
  it("picks the kit from the board's round type; only coding has a panel", () => {
    expect(setup(codingBoard()).xr.kit.id).toBe('coding');
    expect(setup(codingBoard()).xr.panel).not.toBeNull();
    for (const kit of ['hld', 'lld', 'pm', 'meeting'] as const) {
      const { xr } = setup(emptyBoard({ kit }));
      expect(xr.kit.id).toBe(kit);
      expect(xr.panel).toBeNull();
    }
  });

  it('the code panel stands beside the sheet on the dominant side, facing the user', () => {
    for (const side of ['right', 'left'] as const) {
      const { port, xr } = setup(codingBoard(), side);
      port.scene.updateMatrixWorld(true);
      const rect = xr.kit.panel!;
      const toWorld = (x: number, y: number) => xr.panel!.frame.localToWorld(panelToLocal(rect, x, y, 0));
      const bottom = toWorld(rect.x + rect.w / 2, rect.y + rect.h);
      const top = toWorld(rect.x + rect.w / 2, rect.y);
      // Upright (about 30 cm tall, tilted back), standing on the desk (0.75 m).
      expect(top.y - bottom.y).toBeGreaterThan(0.27);
      expect(bottom.y).toBeGreaterThan(0.74);
      expect(bottom.y).toBeLessThan(0.8);
      // Beside the sheet, on the chosen side.
      expect(side === 'right' ? bottom.x > 0.33 : bottom.x < -0.33).toBe(true);
      // Its screen faces the user (+Z) and is turned toward the middle.
      const n = new Vector3(0, 1, 0).transformDirection(xr.panel!.frame.matrixWorld);
      expect(n.z).toBeGreaterThan(0.5);
      expect(side === 'right' ? n.x < 0 : n.x > 0).toBe(true);
    }
  });

  it('a hand pinches a line on the standing panel and drags it down: one code.move', () => {
    const { port, store, sent, xr } = setup(codingBoard());
    port.scene.updateMatrixWorld(true);
    const rect = xr.kit.panel!;
    const at = (x: number, y: number) => {
      const w = xr.panel!.frame.localToWorld(panelToLocal(rect, x, y, 1));
      port.setHand('right', { x: w.x, y: w.y, z: w.z });
    };
    const l2 = codeLineRect(rect, 1);
    const l3 = codeLineRect(rect, 2);
    const path: [number, number][] = [];
    // From the middle of line 2 to the lower part of line 3 (past the 1.5 cm drag threshold).
    const endY = l3.y + l3.h - 0.15;
    for (let i = 0; i <= 10; i++) path.push([l2.x + 8, l2.y + l2.h / 2 + ((endY - l2.y - l2.h / 2) * i) / 10]);
    for (let i = 0; i < 12; i++) {
      at(...path[0]!);
      port.frame();
    }
    port.select('right', 'start');
    for (let i = 0; i < 8; i++) port.frame();
    for (const p of path) {
      at(...p);
      port.frame();
    }
    for (let i = 0; i < 12; i++) port.frame();
    port.select('right', 'end');
    port.frame();
    expect(sent).toEqual([expect.objectContaining({ op: 'code.move', args: { id: 'l2', after: 'l3' } })]);
    expect(store.board.code!.lines.map((l) => l.id)).toEqual(['l1', 'l3', 'l2']);
  });

  it('the panel uploads only when the code changes', () => {
    const { port, store, xr } = setup(codingBoard());
    const before = xr.panel!.stats.uploads;
    for (let i = 0; i < 10; i++) port.frame();
    expect(xr.panel!.stats.uploads).toBe(before);
    store.apply({ op_id: 'c1', src: 'scribe', op: 'code.insert', args: { line: { id: 'l4', indent: 1, text: 'return s', src: 'scribe' }, after: 'l3' } });
    port.frame();
    expect(xr.panel!.stats.uploads).toBe(before + 1);
  });

  it('code text is big enough to read at the panel distance (0.9 cm at 0.6 m, scaled)', () => {
    const { port, xr } = setup(codingBoard());
    port.scene.updateMatrixWorld(true);
    const rect = xr.kit.panel!;
    // Seated eyes: about 0.48 m over the desk, the sheet's near edge 0.20 m in front (plan, Task 15).
    const desk = port.deskPose;
    const eye = new Vector3(desk.origin.x, desk.deskY + 0.48, desk.origin.z + 0.2);
    const centre = xr.panel!.frame.localToWorld(panelToLocal(rect, rect.x + rect.w / 2, rect.y + rect.h / 2, 0));
    const d = centre.distanceTo(eye);
    expect(d).toBeGreaterThan(0.5);
    expect(CODE_FONT_CM).toBeGreaterThanOrEqual((0.9 * d) / 0.6);
  });

  it('kit ops play their sounds: snap to place or reorder, click for ticks and chips, erase for the bin', () => {
    const op = (name: string, args: object) => ({ op_id: 'x', src: 'hand', op: name, args }) as unknown as BoardOp;
    expect(sfxForOp(op('code.move', { id: 'l1', after: null }))).toBe('snap');
    expect(sfxForOp(op('code.indent', { id: 'l1', delta: 1 }))).toBe('snap');
    expect(sfxForOp(op('member.move', { id: 'm1', to_class_id: 'c2' }))).toBe('snap');
    expect(sfxForOp(op('present.show', { kind: 'number', ref: 'k1', t: 1 }))).toBe('snap');
    expect(sfxForOp(op('code.complexity', { slot: 'time', value: 'O(n)' }))).toBe('click');
    expect(sfxForOp(op('agenda.check', { id: 'a1', done: true, t: 1 }))).toBe('click');
    expect(sfxForOp(op('edge.set_rel', { id: 'e1', rel: 'is_a' }))).toBe('click');
    expect(sfxForOp(op('code.trace', { line: 'l1', t: 1 }))).toBe('click');
    expect(sfxForOp(op('code.delete', { id: 'l1' }))).toBe('erase');
    expect(sfxForOp(op('member.remove', { id: 'm1' }))).toBe('erase');
    // And through the injected player, on a hand reorder.
    const port = new FakePort();
    const store = new BoardStore(codingBoard());
    const played: string[] = [];
    const xr = createBoardXR(port, { store, dominantHand: 'right', send: () => {}, sendGhostReject: () => {}, makeCanvas: stubCanvas, sfx: { play: (n) => played.push(n) } });
    port.frame();
    port.scene.updateMatrixWorld(true);
    const rect = xr.kit.panel!;
    const at = (x: number, y: number) => {
      const w = xr.panel!.frame.localToWorld(panelToLocal(rect, x, y, 1));
      port.setHand('right', { x: w.x, y: w.y, z: w.z });
    };
    const l2 = codeLineRect(rect, 1);
    for (let i = 0; i < 12; i++) {
      at(l2.x + 8, l2.y + l2.h / 2);
      port.frame();
    }
    port.select('right', 'start');
    for (let i = 0; i < 8; i++) port.frame();
    for (let i = 0; i <= 10; i++) {
      at(l2.x + 8, l2.y + l2.h / 2 + (2 * l2.h * i) / 10);
      port.frame();
    }
    for (let i = 0; i < 12; i++) port.frame();
    port.select('right', 'end');
    port.frame();
    expect(store.board.code!.lines.map((l) => l.id)).toEqual(['l1', 'l3', 'l2']);
    expect(played).toContain('snap');
  });
});
