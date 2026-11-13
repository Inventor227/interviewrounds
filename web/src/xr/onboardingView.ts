// What the first-round onboarding shows on the sheet: a translucent ghost hand that pinches and draws a box in a
// loop (3 s), a short line beyond the sheet's far edge ("Pinch and draw a box", then "Say its name") and a Skip
// button on that line. Everything lives in the sheet's frame, so it lies on the user's desk with the sheet.
// One merged mesh for the hand, one for the stroke: two draw calls while it shows, none after.

import { PokeInteractable, RayInteractable, UIKitDocument, type World } from '@iwsdk/core';
import { BoxGeometry, BufferAttribute, BufferGeometry, CapsuleGeometry, Group, Mesh, MeshBasicMaterial, SphereGeometry, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { button, panel, set, show, text, type Button } from './ui/style';

export type OnboardViewStep = 'box' | 'name';
/** What the user draws with right now. The input lane provides the live value (`activeInput`, `onInputChange`). */
export type ActiveInput = 'hands' | 'controllers';

/** The lines of the two steps per input (short on purpose: the ghost does the teaching). */
export const ONBOARD_COPY: Record<ActiveInput, Record<OnboardViewStep, string>> = {
  hands: { box: 'Pinch and draw a box', name: 'Say its name' },
  controllers: { box: 'Pull the trigger and draw a box', name: 'Say its name' },
};
export const ONBOARD_SKIP = 'Skip';

/** One loop of the ghost hand, in seconds (Meta hands onboarding: a short looping demonstration). */
export const LOOP_S = 3;
const REACH_S = 0.4;
const DRAW_S = 2.0;
const SNAP_S = 0.25;

/** The demonstrated box on the sheet, in metres in the sheet frame (x right, z toward the user, origin near edge centre). */
export const DEMO_BOX = { x0: -0.1, x1: 0.06, zFar: -0.3, zNear: -0.18 };
const STROKE_W = 0.004;
const HOVER = 0.012;

/** Where the pinch point is at loop time t (s): position in the sheet frame, how much of the box is drawn, opacity. */
export function demoAt(t: number): { x: number; y: number; z: number; drawn: number; alpha: number; snapped: boolean } {
  const u = ((t % LOOP_S) + LOOP_S) % LOOP_S;
  const { x0, x1, zFar, zNear } = DEMO_BOX;
  if (u < REACH_S) {
    const k = u / REACH_S;
    return { x: x0, y: HOVER + (1 - k) * 0.05, z: zFar, drawn: 0, alpha: k, snapped: false };
  }
  if (u < REACH_S + DRAW_S) {
    const d = (u - REACH_S) / DRAW_S;
    const p = pointOnBox(d);
    return { x: p.x, y: HOVER, z: p.z, drawn: d, alpha: 1, snapped: false };
  }
  const rest = u - REACH_S - DRAW_S;
  const out = Math.max(0, 1 - Math.max(0, rest - SNAP_S) / (LOOP_S - REACH_S - DRAW_S - SNAP_S));
  return { x: x0, y: HOVER + Math.min(1, rest / SNAP_S) * 0.04, z: zFar, drawn: 1, alpha: out, snapped: true };
}

/** A point d (0..1) of the way round the box, from the far-left corner clockwise as seen from above. */
export function pointOnBox(d: number): { x: number; z: number } {
  const { x0, x1, zFar, zNear } = DEMO_BOX;
  const w = x1 - x0;
  const h = zNear - zFar;
  let s = Math.max(0, Math.min(1, d)) * 2 * (w + h);
  if (s <= w) return { x: x0 + s, z: zFar };
  s -= w;
  if (s <= h) return { x: x1, z: zFar + s };
  s -= h;
  if (s <= w) return { x: x1 - s, z: zNear };
  s -= w;
  return { x: x0, z: zNear - s };
}

/** A stylised right hand in a pinch, its pinch point at the origin, the wrist toward +Z (the user) and +X. */
function handGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const cap = (r: number, len: number, rx: number, rz: number, x: number, y: number, z: number) => {
    const g = new CapsuleGeometry(r, len, 3, 8);
    g.rotateX(rx);
    g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g);
  };
  // Index and thumb meet at the pinch point.
  cap(0.0075, 0.045, 0.95, 0, 0.004, 0.02, 0.016);
  cap(0.0085, 0.035, 1.25, 0.5, -0.012, 0.012, 0.02);
  // The other fingers, curled.
  cap(0.0075, 0.03, 0.5, 0, 0.02, 0.03, 0.034);
  cap(0.007, 0.028, 0.45, 0, 0.034, 0.03, 0.04);
  cap(0.0065, 0.024, 0.4, 0, 0.046, 0.028, 0.047);
  const palm = new BoxGeometry(0.07, 0.022, 0.075, 1, 1, 1);
  palm.rotateX(-0.35);
  palm.translate(0.02, 0.045, 0.075);
  parts.push(palm);
  const tip = new SphereGeometry(0.006, 10, 8);
  parts.push(tip);
  const out = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return out;
}

export class OnboardingView {
  /** Add to the sheet frame (Room.sheetAnchor). */
  readonly group = new Group();
  /** The line and the Skip button (a UIKit panel; needs ray and poke interactables). */
  readonly card = new Group();
  private readonly hand: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly stroke: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly strokePos: BufferAttribute;
  private readonly doc: UIKitDocument;
  private readonly line;
  private readonly skip: Button;
  private step: OnboardViewStep | null = null;
  private input: ActiveInput = 'hands';
  private t0 = 0;

  constructor(onSkip: () => void) {
    this.group.name = 'onboarding';
    this.hand = new Mesh(handGeometry(), new MeshBasicMaterial({ color: 0xf4f2ee, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false }));
    this.hand.name = 'ghost-hand';
    this.hand.renderOrder = 20;
    // The stroke: four quads round the box, grown as the hand passes.
    const g = new BufferGeometry();
    this.strokePos = new BufferAttribute(new Float32Array(4 * 4 * 3), 3);
    g.setAttribute('position', this.strokePos);
    const idx: number[] = [];
    for (let q = 0; q < 4; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    g.setIndex(idx);
    this.stroke = new Mesh(g, new MeshBasicMaterial({ color: 0x2d6aa3, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: 2 }));
    this.stroke.name = 'ghost-stroke';
    this.stroke.frustumCulled = false;
    this.stroke.renderOrder = 19;
    this.group.add(this.stroke, this.hand);

    this.card.name = 'onboarding-card';
    const root = panel({ flexDirection: 'row', alignItems: 'center', gap: 2, paddingX: 2, paddingY: 1.2, borderRadius: 2.2 });
    this.line = text('', { fontSize: 1.7, fontWeight: 'semi-bold' });
    this.skip = button(ONBOARD_SKIP, { width: 9, height: 4.4, onClick: onSkip });
    root.add(this.line, this.skip.root);
    this.doc = new UIKitDocument(root);
    this.card.add(this.doc);
    // Standing just beyond the sheet's far edge, leaning back toward the user's eyes (the frame itself is tilted 15°).
    this.card.position.set(0, 0.06, -0.44);
    this.card.rotation.set(-0.95, 0, 0);
    this.group.add(this.card);
    this.group.visible = false;
  }

  /** Shows a step (the hand only demonstrates the box); null hides everything. */
  show(step: OnboardViewStep | null, nowMs: number): void {
    this.step = step;
    this.t0 = nowMs;
    this.group.visible = step !== null;
    this.hand.visible = this.stroke.visible = step === 'box';
    if (step) set(this.line, { text: ONBOARD_COPY[this.input][step] });
    show(this.skip.root, step === 'box');
  }

  /**
   * Hands or controllers: the line follows at once.
   * CONTROLLER VARIANT: the ghost is the pinching hand for both today. A ghost controller (trigger pulled, the same
   * box path from demoAt) belongs here, swapped in for `this.hand` when input is 'controllers'.
   */
  setInput(input: ActiveInput): void {
    if (input === this.input) return;
    this.input = input;
    if (this.step) set(this.line, { text: ONBOARD_COPY[input][this.step] });
  }

  get showing(): OnboardViewStep | null {
    return this.step;
  }

  update(nowMs: number): void {
    if (this.step !== 'box') return;
    const d = demoAt((nowMs - this.t0) / 1000);
    this.hand.position.set(d.x, d.y, d.z);
    this.hand.material.opacity = 0.5 * d.alpha;
    this.stroke.material.opacity = (d.snapped ? 1 : 0.85) * Math.min(1, d.alpha + (d.snapped ? 0 : 1));
    this.writeStroke(d.drawn);
  }

  private writeStroke(drawn: number): void {
    const { x0, x1, zFar, zNear } = DEMO_BOX;
    const w = x1 - x0;
    const h = zNear - zFar;
    const per = 2 * (w + h);
    const lens = [w, h, w, h];
    const starts: [number, number][] = [
      [x0, zFar],
      [x1, zFar],
      [x1, zNear],
      [x0, zNear],
    ];
    const dirs: [number, number][] = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    let left = Math.max(0, Math.min(1, drawn)) * per;
    const a = this.strokePos.array as Float32Array;
    const y = 0.002;
    for (let q = 0; q < 4; q++) {
      const len = Math.max(0, Math.min(lens[q]!, left));
      left -= lens[q]!;
      const [sx, sz] = starts[q]!;
      const [dx, dz] = dirs[q]!;
      // Perpendicular in the sheet plane.
      const px = -dz * (STROKE_W / 2);
      const pz = dx * (STROKE_W / 2);
      const ex = sx + dx * len;
      const ez = sz + dz * len;
      a.set([sx - px, y, sz - pz, ex - px, y, ez - pz, ex + px, y, ez + pz, sx + px, y, sz + pz], q * 12);
    }
    this.strokePos.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.hand.geometry.dispose();
    this.hand.material.dispose();
    this.stroke.geometry.dispose();
    this.stroke.material.dispose();
    this.doc.dispose();
  }
}

/** Puts the view on the sheet and makes its Skip button reachable by ray and by touch. Returns a cleanup. */
export function mountOnboardingView(world: World, sheetAnchor: Object3D, view: OnboardingView): () => void {
  sheetAnchor.add(view.group);
  const e = world.createTransformEntity(view.card);
  e.addComponent(RayInteractable);
  e.addComponent(PokeInteractable);
  return () => {
    e.destroy();
    view.dispose();
  };
}
