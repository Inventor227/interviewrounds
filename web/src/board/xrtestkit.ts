// Test helpers for the board in XR: a fake XR port the tests drive frame by frame.
import { Object3D } from 'three';
import type { BoardXRPort, DeskPose, HeadPose, SelectPhase, Vec3, XRHandSample } from './port';
import { placeAnchor, sheetToWorld } from './sheetMath';

export class FakePort implements BoardXRPort {
  readonly sheetAnchor = new Object3D();
  readonly scene = new Object3D();
  now = 0;
  wallTex: unknown = null;
  private frames = new Set<(dt: number, now: number) => void>();
  private selects = new Set<(hand: 'left' | 'right', phase: SelectPhase, now: number) => void>();
  private handMap = new Map<'left' | 'right', XRHandSample>();

  constructor(readonly deskPose: DeskPose = { origin: { x: 0, y: 0.75, z: -0.2 }, yaw: 0, deskY: 0.75 }) {
    this.scene.add(this.sheetAnchor);
    placeAnchor(this.sheetAnchor, deskPose);
  }

  onFrame(cb: (dt: number, now: number) => void): () => void {
    this.frames.add(cb);
    return () => this.frames.delete(cb);
  }
  onSelect(cb: (hand: 'left' | 'right', phase: SelectPhase, now: number) => void): () => void {
    this.selects.add(cb);
    return () => this.selects.delete(cb);
  }
  hands(): XRHandSample[] {
    return [...this.handMap.values()];
  }
  headPose(): HeadPose {
    return { pos: { x: 0, y: 1.2, z: 0.25 }, yaw: 0, pitch: -0.6 };
  }
  desk(): DeskPose | null {
    return this.deskPose;
  }
  wallboardTexture(tex: unknown): void {
    this.wallTex = tex;
  }

  /** Puts a hand's pinch point (thumb and index 1 cm apart around it) at a world point; null = not tracked. */
  setHand(hand: 'left' | 'right', at: Vec3 | null): void {
    if (!at) {
      this.handMap.set(hand, { hand, tracked: false, thumbTip: null, indexTip: null });
      return;
    }
    this.handMap.set(hand, {
      hand,
      tracked: true,
      thumbTip: { x: at.x - 0.005, y: at.y, z: at.z },
      indexTip: { x: at.x + 0.005, y: at.y, z: at.z },
    });
  }

  /** The hand over a board point, `hCm` above the sheet surface. */
  handAt(hand: 'left' | 'right', xCm: number, yCm: number, hCm = 0.5): void {
    this.setHand(hand, sheetToWorld(this.sheetAnchor, xCm, yCm, hCm));
  }

  frame(ms = 14): void {
    this.now += ms;
    for (const cb of [...this.frames]) cb(ms / 1000, this.now);
  }

  select(hand: 'left' | 'right', phase: SelectPhase): void {
    for (const cb of [...this.selects]) cb(hand, phase, this.now);
  }

  /** Pinch at the first point, drag through the rest (one frame each), release at the last. */
  pinchStroke(hand: 'left' | 'right', points: [number, number][]): void {
    const [first, ...rest] = points;
    if (!first) return;
    this.handAt(hand, first[0], first[1]);
    this.frame();
    this.select(hand, 'start');
    for (const [x, y] of rest) {
      this.handAt(hand, x, y);
      this.frame();
    }
    // Hold at the end a moment, as a hand does, so the filter settles there.
    for (let i = 0; i < 12; i++) this.frame();
    this.select(hand, 'end');
    this.frame();
  }
}
