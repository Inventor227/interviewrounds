// Test helpers for the board in XR: a fake XR port the tests drive frame by frame.
import { Object3D } from 'three';
import { PINCH_REJOIN_MS } from './hand';
import type { HapticName } from './pointer';
import type { BoardXRPort, DeskPose, HeadPose, SelectPhase, Vec3, XRControllerSample, XRHandSample } from './port';
import { placeAnchor, sheetToWorld } from './sheetMath';

export class FakePort implements BoardXRPort {
  readonly sheetAnchor = new Object3D();
  readonly scene = new Object3D();
  now = 0;
  wallTex: unknown = null;
  private frames = new Set<(dt: number, now: number) => void>();
  private selects = new Set<(hand: 'left' | 'right', phase: SelectPhase, now: number, kind?: 'hand' | 'controller') => void>();
  private handMap = new Map<'left' | 'right', XRHandSample>();
  private ctrlMap = new Map<'left' | 'right', XRControllerSample>();
  private buttonCbs = new Set<(hand: 'left' | 'right', button: 'primary' | 'secondary', now: number) => void>();
  /** Every pulse the board asked for. */
  readonly pulses: { hand: 'left' | 'right'; name: HapticName }[] = [];
  private ends = new Set<() => void>();

  onSessionEnd(cb: () => void): () => void {
    this.ends.add(cb);
    return () => this.ends.delete(cb);
  }

  /** The XR session ends: tooling and the app stop sending frames. */
  endSession(): void {
    for (const cb of [...this.ends]) cb();
  }

  constructor(readonly deskPose: DeskPose = { origin: { x: 0, y: 0.75, z: -0.2 }, yaw: 0, deskY: 0.75 }) {
    this.scene.add(this.sheetAnchor);
    placeAnchor(this.sheetAnchor, deskPose);
  }

  onFrame(cb: (dt: number, now: number) => void): () => void {
    this.frames.add(cb);
    return () => this.frames.delete(cb);
  }
  onSelect(cb: (hand: 'left' | 'right', phase: SelectPhase, now: number, kind?: 'hand' | 'controller') => void): () => void {
    this.selects.add(cb);
    return () => this.selects.delete(cb);
  }
  hands(): XRHandSample[] {
    return [...this.handMap.values()];
  }
  controllers(): XRControllerSample[] {
    return [...this.ctrlMap.values()];
  }
  onButton(cb: (hand: 'left' | 'right', button: 'primary' | 'secondary', now: number) => void): () => void {
    this.buttonCbs.add(cb);
    return () => this.buttonCbs.delete(cb);
  }
  haptic(hand: 'left' | 'right', name: HapticName): void {
    this.pulses.push({ hand, name });
  }

  /** A controller button press (A or X is `primary`). */
  button(hand: 'left' | 'right', button: 'primary' | 'secondary' = 'primary'): void {
    for (const cb of [...this.buttonCbs]) cb(hand, button, this.now);
  }

  /** A held controller: its tip at a world point, aiming along `dir`; null = not held (the side has no controller). */
  setController(hand: 'left' | 'right', tip: Vec3 | null, dir: Vec3 = { x: 0, y: -1, z: 0 }, extra: Partial<XRControllerSample> = {}): void {
    if (!tip) {
      this.ctrlMap.delete(hand);
      return;
    }
    const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
    this.ctrlMap.set(hand, { hand, tracked: true, tip, dir: { x: dir.x / n, y: dir.y / n, z: dir.z / n }, ...extra });
  }

  /** The controller's tip over a board point, `hCm` above the sheet, pointing straight down at it. */
  controllerAt(hand: 'left' | 'right', xCm: number, yCm: number, hCm = 0.5): void {
    const tip = sheetToWorld(this.sheetAnchor, xCm, yCm, hCm);
    const on = sheetToWorld(this.sheetAnchor, xCm, yCm, 0);
    this.setController(hand, tip, hCm > 0 ? { x: on.x - tip.x, y: on.y - tip.y, z: on.z - tip.z } : { x: 0, y: -1, z: 0 });
  }

  /** The controller held `fromCm` back from the sheet (along its normal, from a point `backCm` nearer the user), its ray aimed at a board point. */
  controllerAimAt(hand: 'left' | 'right', xCm: number, yCm: number, fromCm = 30, backCm = 20): void {
    const tip = sheetToWorld(this.sheetAnchor, xCm, yCm + backCm, fromCm);
    const on = sheetToWorld(this.sheetAnchor, xCm, yCm, 0);
    this.setController(hand, tip, { x: on.x - tip.x, y: on.y - tip.y, z: on.z - tip.z });
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

  /** Sets a hand's thumb and index tips one by one (tracking noise moves them apart); null = not tracked. */
  setHandTips(hand: 'left' | 'right', thumb: Vec3 | null, index: Vec3 | null): void {
    this.handMap.set(hand, { hand, tracked: !!(thumb && index), thumbTip: thumb, indexTip: index });
  }

  /** The hand over a board point, `hCm` above the sheet surface. */
  handAt(hand: 'left' | 'right', xCm: number, yCm: number, hCm = 0.5): void {
    this.setHand(hand, sheetToWorld(this.sheetAnchor, xCm, yCm, hCm));
  }

  frame(ms = 14): void {
    this.now += ms;
    for (const cb of [...this.frames]) cb(ms / 1000, this.now);
  }

  select(hand: 'left' | 'right', phase: SelectPhase, kind?: 'hand' | 'controller'): void {
    for (const cb of [...this.selects]) cb(hand, phase, this.now, kind);
  }

  /**
   * A controller stroke: settle on the first point, pull the trigger, move through the rest, let go. `mode` is
   * `near` (the tip on the sheet) or `far` (the ray from a distance).
   */
  triggerStroke(hand: 'left' | 'right', points: [number, number][], mode: 'near' | 'far' = 'near'): void {
    const at = (x: number, y: number) => (mode === 'near' ? this.controllerAt(hand, x, y) : this.controllerAimAt(hand, x, y));
    const [first, ...rest] = points;
    if (!first) return;
    for (let i = 0; i < 12; i++) {
      at(first[0], first[1]);
      this.frame();
    }
    this.select(hand, 'start', 'controller');
    for (let i = 0; i < 8; i++) this.frame();
    for (const [x, y] of rest) {
      at(x, y);
      this.frame();
    }
    for (let i = 0; i < 12; i++) this.frame();
    this.select(hand, 'end', 'controller');
    this.frame();
  }

  /** Pinch at the first point, drag through the rest (one frame each), release at the last. */
  pinchStroke(hand: 'left' | 'right', points: [number, number][]): void {
    const [first, ...rest] = points;
    if (!first) return;
    // Arrive and settle over the first point before pinching, as a hand does (the filter
    // would otherwise still be catching up from wherever the hand was).
    for (let i = 0; i < 12; i++) {
      this.handAt(hand, first[0], first[1]);
      this.frame();
    }
    this.select(hand, 'start');
    // The fingers close first: a moment still before the stroke moves.
    for (let i = 0; i < 8; i++) this.frame();
    for (const [x, y] of rest) {
      this.handAt(hand, x, y);
      this.frame();
    }
    // Hold at the end a moment, as a hand does, so the filter settles there.
    for (let i = 0; i < 12; i++) this.frame();
    this.select(hand, 'end');
    // A drag's release lands once the pinch has stayed open past the rejoin window (hand.ts PINCH_REJOIN_MS).
    for (let i = 0; i <= Math.ceil(PINCH_REJOIN_MS / 14); i++) this.frame();
  }
}

/** A 2D context that accepts every call (jsdom has no canvas); counts calls. */
export function stubContext(): CanvasRenderingContext2D & { calls: number } {
  const state: Record<string, unknown> = { font: '10px sans-serif', calls: 0 };
  return new Proxy(state, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        t.calls = (t.calls as number) + 1;
        if (prop === 'measureText') return { width: String(args[0]).length * 5 };
        if (prop === 'getLineDash') return [];
        return undefined;
      };
    },
    set(t, prop: string, v) {
      t[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { calls: number };
}

/** A canvas stand-in with a stub 2D context, for Sheet, Tray and Bin in tests. */
export function stubCanvas(w: number, h: number): HTMLCanvasElement {
  const ctx = stubContext();
  return { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
}
