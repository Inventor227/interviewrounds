// What the board needs from the XR app: a frame to hang the sheet on, per-frame hands with
// joint poses, pinch (select) events per hand, the head and the desk. The XR room (web/src/xr)
// implements it; tests use a fake. Shapes follow web/src/xr (HandState, HeadPose, DeskPose).
// TODO: import Vec3, HeadPose and DeskPose from web/src/xr once the room is on main.
import type { Object3D, Texture } from 'three';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface HeadPose {
  pos: Vec3;
  /** Radians, CCW from above; 0 looks down -Z. */
  yaw: number;
  /** Radians; positive looks up. */
  pitch: number;
}

/** The sheet's near edge centre on the desk top, the facing, and the desk height. */
export interface DeskPose {
  origin: Vec3;
  yaw: number;
  deskY: number;
}

/** One hand this frame, in the same space as the sheet anchor's world matrix. */
export interface XRHandSample {
  hand: 'left' | 'right';
  tracked: boolean;
  /** Joint positions; null when the joint pose is missing this frame. */
  thumbTip: Vec3 | null;
  indexTip: Vec3 | null;
}

export type SelectPhase = 'start' | 'end';

export interface BoardXRPort {
  /**
   * The sheet frame: origin at the sheet's near edge centre, +X right, -Z toward the far
   * edge, +Y the surface normal (web/src/xr Room.sheetAnchor). Board meshes are added under it.
   */
  readonly sheetAnchor: Object3D;
  /** Per-frame callback after input is read; dt in seconds. Returns an unsubscribe. */
  onFrame(cb: (dt: number, nowMs: number) => void): () => void;
  hands(): XRHandSample[];
  /** XR selectstart / selectend per hand (a pinch on hands, the trigger on controllers). */
  onSelect(cb: (hand: 'left' | 'right', phase: SelectPhase, nowMs: number) => void): () => void;
  headPose(): HeadPose;
  /** The placed desk, null until placement finishes. */
  desk(): DeskPose | null;
  /** Shows the board on the wall whiteboard (Room.wallboardTexture); null clears it. */
  wallboardTexture?(tex: Texture | null): void;
}

/** Feedback sounds (short and quiet; web/src/xr plays them through the session's audio context). */
export type SfxName = 'snap' | 'pen' | 'erase' | 'flap' | 'click';

export interface Sfx {
  play(name: SfxName): void;
}
