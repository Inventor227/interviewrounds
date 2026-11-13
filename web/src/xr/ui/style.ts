// Shared look for the in-headset panels: dark glass over passthrough, large light text, one deep accent.
// UIKit units are centimetres (pixelSize 0.01 m). Text sizes keep cap height at or above 1.1 cm for primary
// labels (Inter cap height is about 0.73 em, so 1.6 cm type), 0.8 cm minimum for secondary text.

import { UIKit } from '@iwsdk/core';
import {
  CircleGeometry,
  Mesh,
  ShaderMaterial,
  type Object3D,
} from 'three';

export const GLASS = 'rgba(20,22,26,0.78)';
export const GLASS_SOLID = 'rgba(20,22,26,0.92)';
export const INK = '#F4F2EE';
export const INK_MUTED = '#B9B4AB';
export const ACCENT = '#1F4E79';
export const ACCENT_HI = '#2D6AA3';
export const BUTTON = 'rgba(255,255,255,0.10)';
export const BUTTON_HOVER = 'rgba(255,255,255,0.18)';
export const BUTTON_ACTIVE = 'rgba(255,255,255,0.28)';
export const AMBER = '#E2A33B';
export const GOOD = '#4FB27A';
export const BAD = '#D9705E';

export const TEXT_PRIMARY = 1.6;
export const TEXT_BODY = 1.5;
export const TEXT_SECONDARY = 1.15;
export const TEXT_SMALL = 0.9;

export type Props = Record<string, unknown>;

/** A glass panel root. */
export function panel(props: Props = {}): UIKit.Container {
  return new UIKit.Container({
    backgroundColor: GLASS,
    borderRadius: 2.2,
    padding: 1.6,
    flexDirection: 'column',
    gap: 1.0,
    pointerEvents: 'auto',
    ...props,
  } as never);
}

export function row(props: Props = {}): UIKit.Container {
  return new UIKit.Container({ flexDirection: 'row', alignItems: 'center', gap: 1.2, ...props } as never);
}

export function col(props: Props = {}): UIKit.Container {
  return new UIKit.Container({ flexDirection: 'column', gap: 0.6, ...props } as never);
}

export function text(value: string, props: Props = {}): UIKit.Text {
  return new UIKit.Text({ text: value, fontSize: TEXT_BODY, color: INK, ...props } as never);
}

/** Sets a component's properties (UIKit's setProperties with loose typing for our prop bags). */
export function set(c: UIKit.Component, props: Props): void {
  (c as unknown as { setProperties(p: Props): void }).setProperties(props);
}

export function show(c: UIKit.Component, visible: boolean): void {
  set(c, { display: visible ? 'flex' : 'none' });
}

export interface ButtonOpts {
  width?: number;
  height?: number;
  primary?: boolean;
  fontSize?: number;
  onClick?: () => void;
  onDown?: () => void;
  onUp?: () => void;
  /** The pointer left the button (defaults to onUp). */
  onLeave?: () => void;
}

export interface Button {
  root: UIKit.Container;
  label: UIKit.Text;
  setLabel(s: string): void;
  setOn(on: boolean): void;
}

/**
 * A large poke target (at least 4 × 4 cm, Meta hands guidance) with a pressed look.
 *
 * A press counts when the pointer goes down on the button and comes up on it, however long it was held: a poke, a
 * pinch on the hand ray or a controller's trigger on its ray. The pointer library's own click gives up after a
 * fixed time, and a slow, deliberate trigger pull or pinch would then do nothing. Sliding off before letting go
 * cancels.
 */
export function button(labelText: string, opts: ButtonOpts = {}): Button {
  const base = opts.primary ? ACCENT : BUTTON;
  const hover = opts.primary ? ACCENT_HI : BUTTON_HOVER;
  let armed = false;
  const root = new UIKit.Container({
    width: opts.width ?? 8,
    height: opts.height ?? 4.4,
    borderRadius: 1.2,
    backgroundColor: base,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    hover: { backgroundColor: hover },
    active: { backgroundColor: opts.primary ? ACCENT_HI : BUTTON_ACTIVE, transformScaleX: 0.97, transformScaleY: 0.97 },
    onPointerDown: () => {
      armed = true;
      opts.onDown?.();
    },
    onPointerUp: () => {
      const pressed = armed;
      armed = false;
      opts.onUp?.();
      if (pressed) opts.onClick?.();
    },
    onPointerLeave: () => {
      armed = false;
      (opts.onLeave ?? opts.onUp)?.();
    },
  } as never);
  const label = text(labelText, { fontSize: opts.fontSize ?? TEXT_PRIMARY, fontWeight: 'medium', pointerEvents: 'none' });
  root.add(label);
  return {
    root,
    label,
    setLabel: (s) => set(label, { text: s }),
    setOn: (on) => set(root, { backgroundColor: on ? ACCENT : base, hover: { backgroundColor: on ? ACCENT_HI : hover } }),
  };
}

/** A horizontal bar with a fill fraction (0..1). */
export function bar(widthCm: number, color = ACCENT_HI): { root: UIKit.Container; set(f: number): void } {
  const root = new UIKit.Container({
    width: widthCm,
    height: 0.9,
    borderRadius: 0.45,
    backgroundColor: 'rgba(255,255,255,0.12)',
    flexDirection: 'row',
  } as never);
  const fill = new UIKit.Container({ width: 0, height: '100%', borderRadius: 0.45, backgroundColor: color } as never);
  root.add(fill);
  return {
    root,
    set: (f: number) => set(fill, { width: `${Math.round(Math.max(0, Math.min(1, f)) * 1000) / 10}%` }),
  };
}

/** A progress ring (hold to confirm). Radius in metres; progress 0..1 fills clockwise from 12 o'clock. */
export function holdRing(radius: number, color = INK): { mesh: Mesh; set(p: number): void } {
  const mat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: { uProgress: { value: 0 }, uColor: { value: [1, 1, 1] }, uOpacity: { value: 0.95 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uProgress;
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float band = smoothstep(0.74, 0.78, r) * (1.0 - smoothstep(0.96, 1.0, r));
        float a = atan(p.x, p.y);              // 0 at 12 o'clock, clockwise positive
        float t = (a < 0.0 ? a + 6.2831853 : a) / 6.2831853;
        float on = step(t, uProgress);
        float alpha = band * mix(0.18, 1.0, on) * uOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
      }`,
  });
  const c = parseHex(color);
  (mat.uniforms.uColor!.value as number[]).splice(0, 3, ...c);
  const mesh = new Mesh(new CircleGeometry(radius, 48), mat);
  // Drawn only: a pointer goes through it to the button it surrounds (it would otherwise take the ray from the
  // button the moment it shows, and a hold by ray could never finish).
  mesh.raycast = () => {};
  mesh.renderOrder = 10;
  mesh.visible = false;
  return {
    mesh,
    set(p: number) {
      mat.uniforms.uProgress!.value = p;
      mesh.visible = p > 0;
    },
  };
}

function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** mm:ss */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Walks up to find the nearest object with a userData flag, for tooling. */
export function tag(o: Object3D, name: string): Object3D {
  o.name = name;
  return o;
}
