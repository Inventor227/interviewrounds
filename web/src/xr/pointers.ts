// The pointer library under IWSDK (@pmndrs/pointer-events) registers every pointer it makes in one global map
// (`pointerEventspointerMap`, for setPointerCapture by id) and never takes one out: the page's mouse and each touch on
// the preview canvas, and the rays, pokes and grabs of the headset. A pointer holds its canvas, its camera and its last
// hit, so after a round the whole room (scene, panels, people, the lost WebGL context) stayed reachable from that map,
// one more room per round in the same tab. Closing a room drops its pointers from the map.

import type { Camera } from 'three';

interface PointerLike {
  getCamera?: unknown;
}

/** Drops every registered pointer that looks through `camera` (one room's). Returns how many were dropped. */
export function forgetPointers(camera: Camera): number {
  const map = (globalThis as { pointerEventspointerMap?: Map<unknown, unknown> }).pointerEventspointerMap;
  if (!(map instanceof Map)) return 0;
  let dropped = 0;
  for (const [id, p] of [...map]) {
    const get = (p as PointerLike | null)?.getCamera;
    if (typeof get !== 'function') continue;
    let cam: unknown;
    try {
      cam = get.call(p);
    } catch {
      continue;
    }
    if (cam === camera) {
      map.delete(id);
      dropped++;
    }
  }
  return dropped;
}
