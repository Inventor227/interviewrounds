// Wall whiteboard, 1.6 × 1.0 m, standing behind the panel. It mirrors the sheet: the board code attaches its
// canvas texture with setTexture() and flags it when the drawing changes. Until then it shows a clean surface.

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, type Texture } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoardFrame } from './seats';

const SURFACE = 0xf3f1ec;

export class Wallboard {
  readonly group = new Group();
  readonly surface: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly frame: Mesh;

  constructor(width = 1.6, height = 1.0) {
    this.group.name = 'wallboard';
    // Unlit so the drawing reads the same in any light; a touch under white so it does not glare over passthrough.
    this.surface = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ color: SURFACE, toneMapped: false }),
    );
    this.surface.name = 'wallboard-surface';
    this.group.add(this.surface);

    // Thin aluminium frame and a pen tray, one merged mesh.
    const t = 0.025;
    const d = 0.03;
    const parts = [
      new BoxGeometry(width + 2 * t, t, d).translate(0, height / 2 + t / 2, -d / 2 + 0.004),
      new BoxGeometry(width + 2 * t, t, d).translate(0, -height / 2 - t / 2, -d / 2 + 0.004),
      new BoxGeometry(t, height, d).translate(-width / 2 - t / 2, 0, -d / 2 + 0.004),
      new BoxGeometry(t, height, d).translate(width / 2 + t / 2, 0, -d / 2 + 0.004),
      new BoxGeometry(width * 0.5, 0.015, 0.06).translate(0, -height / 2 - t - 0.008, 0.02),
      new BoxGeometry(width + 2 * t, height + 2 * t, 0.01).translate(0, 0, -d + 0.004),
    ];
    this.frame = new Mesh(mergeGeometries(parts)!, new MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.45, metalness: 0.6 }));
    this.frame.name = 'wallboard-frame';
    parts.forEach((p) => p.dispose());
    this.group.add(this.frame);
  }

  place(f: BoardFrame): void {
    this.group.position.set(f.pos.x, f.pos.y, f.pos.z);
    this.group.rotation.set(0, f.yaw, 0);
  }

  /** Shows the board canvas (or the clean surface for null). The caller sets tex.needsUpdate when it redraws. */
  setTexture(tex: Texture | null): void {
    const m = this.surface.material;
    if (tex) {
      tex.colorSpace = SRGBColorSpace;
      m.color.set(0xffffff);
      m.color.multiplyScalar(0.95);
    } else {
      m.color.set(SURFACE);
    }
    m.map = tex;
    m.needsUpdate = true;
  }
}
