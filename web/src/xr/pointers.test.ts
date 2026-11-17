import { createRayPointer, getPointerById } from '@pmndrs/pointer-events';
import { Object3D, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { forgetPointers } from './pointers';

describe('forgetPointers', () => {
  it("drops a closed room's pointers from the pointer library's global registry, and only those", () => {
    // Every pointer the library makes (the page's mouse and touches, rays, pokes, grabs) registers itself in a global
    // map and is never removed: without this, each round's whole room stays reachable after the room is closed.
    const roomCamera = new PerspectiveCamera();
    const otherCamera = new PerspectiveCamera();
    const mine = [createRayPointer(() => roomCamera, { current: new Object3D() }, {}), createRayPointer(() => roomCamera, { current: new Object3D() }, {})];
    const other = createRayPointer(() => otherCamera, { current: new Object3D() }, {});
    for (const p of [...mine, other]) expect(getPointerById(p.id)).toBe(p);

    expect(forgetPointers(roomCamera)).toBe(2);

    for (const p of mine) expect(getPointerById(p.id)).toBeUndefined();
    expect(getPointerById(other.id)).toBe(other);
    forgetPointers(otherCamera);
  });

  it('does nothing when the registry is missing or holds something else', () => {
    const cam = new PerspectiveCamera();
    const g = globalThis as { pointerEventspointerMap?: Map<number, unknown> };
    const saved = g.pointerEventspointerMap;
    try {
      g.pointerEventspointerMap = undefined;
      expect(forgetPointers(cam)).toBe(0);
      g.pointerEventspointerMap = new Map<number, unknown>([[1, null], [2, { getCamera: 'no' }], [3, { getCamera: () => { throw new Error('gone'); } }]]);
      expect(forgetPointers(cam)).toBe(0);
      expect(g.pointerEventspointerMap.size).toBe(3);
    } finally {
      g.pointerEventspointerMap = saved;
    }
  });
});
