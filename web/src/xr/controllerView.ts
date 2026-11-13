// What a held controller looks like in the room. The platform's own controller model (IWSDK draws it at the grip)
// is served from this origin: the Meta Quest Touch Plus model, also used for the older Touch controllers, since the
// page may not load anything from another origin. When no model comes up (an unknown controller, a failed load) a
// plain stand-in body is drawn instead. A small dot marks the controller's tip, the point that touches the desk
// and draws on the sheet. Everything here shows only while a controller is that side's input, and goes away when a
// hand takes over.

import { CacheManager, DEFAULT_PROFILES_PATH } from '@iwsdk/core';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, type Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Controller profiles that get the Touch Plus model (the id IWSDK resolves from the input source's profiles). */
export const HOSTED_PROFILES = ['meta-quest-touch-plus', 'meta-quest-touch-pro', 'oculus-touch-v3', 'oculus-touch-v2', 'oculus-touch', 'generic-trigger-squeeze-thumbstick'] as const;
export const HOSTED_MODEL_DIR = 'vendor/input-profiles/meta-quest-touch-plus';

/** Where the platform would fetch a profile's model, and where this origin serves it. */
export function hostedModelUrls(base = '/'): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const id of HOSTED_PROFILES) for (const side of ['left', 'right'] as const) out.push({ from: `${DEFAULT_PROFILES_PATH}/${id}/${side}.glb`, to: `${base}${HOSTED_MODEL_DIR}/${side}.glb` });
  return out;
}

/** Points the platform's controller model loads at this origin. Call once, before a session starts. */
export function hostControllerModels(base = '/'): void {
  for (const { from, to } of hostedModelUrls(base)) CacheManager.setKeyToUrl(from, to);
}

export const TIP_DOT_R = 0.003;
/** The stand-in body waits this long for the platform's model before it shows (the model loads in a moment). */
export const STANDIN_AFTER_MS = 1500;

/**
 * One side's tip dot and stand-in body, in the controller's aim-ray space (the tip at the origin, the ray along
 * -Z, the body behind and below, as on a Touch controller).
 */
export class ControllerView {
  readonly group = new Group();
  readonly tip: Mesh;
  readonly body: Mesh;
  private since: number | null = null;

  constructor(hand: 'left' | 'right') {
    this.group.name = `controller-view-${hand}`;
    this.tip = new Mesh(new SphereGeometry(TIP_DOT_R, 12, 8), new MeshBasicMaterial({ color: 0xf4f2ee, toneMapped: false }));
    this.tip.name = 'controller-tip';
    const head = new BoxGeometry(0.036, 0.03, 0.05).translate(0, -0.006, 0.027);
    const handle = new CylinderGeometry(0.016, 0.014, 0.085, 10).rotateX(Math.PI / 4).translate(0, -0.04, 0.075);
    const geo = mergeGeometries([head.toNonIndexed(), handle.toNonIndexed()])!;
    head.dispose();
    handle.dispose();
    this.body = new Mesh(geo, new MeshStandardMaterial({ color: 0x2e3135, roughness: 0.7, metalness: 0.05 }));
    this.body.name = 'controller-standin';
    this.body.visible = false;
    this.group.add(this.tip, this.body);
    this.group.visible = false;
  }

  /** shown: a controller is this side's input and tracked; hasModel: the platform's model is on screen. */
  set(shown: boolean, hasModel: boolean, nowMs: number): void {
    this.group.visible = shown;
    if (!shown) this.since = null;
    else this.since ??= nowMs;
    this.body.visible = shown && !hasModel && nowMs - (this.since ?? nowMs) >= STANDIN_AFTER_MS;
  }

  attach(raySpace: Object3D): void {
    raySpace.add(this.group);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of [this.tip, this.body]) {
      m.geometry.dispose();
      (m.material as MeshBasicMaterial).dispose();
    }
  }
}
