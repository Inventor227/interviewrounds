// Shared types for the avatar runtime. SeatPose mirrors what the room layout hands over; it is defined here so the
// avatar code builds on its own.

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Where one person sits, in world space. */
export interface SeatPose {
  /** The seat on the floor plane: x and z place the avatar root; y is ignored (deskY sets the height). */
  position: Vec3Like;
  /** Turn about +Y. At yaw 0 the avatar faces +Z. */
  yaw: number;
  /** World height of the table top the avatar's hands rest on. */
  deskY: number;
}

export type AvatarMode = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Temperament of the persona: shifts the resting face a little. */
export type Mood = 'warm' | 'neutral' | 'stern';

/** One avatar entry of /avatars/manifest.json. */
export interface AvatarManifestEntry {
  id: string;
  sex: 'f' | 'm';
  source?: string;
  glb: string;
  anims: string;
  height_m: number;
  eye_bone: string;
  eye_bones?: string[];
  head_bone: string;
  neck_bone?: string;
  morphs: string[];
  tris?: number;
  joints?: number;
  bytes?: number;
  sha256?: string;
}

export interface AvatarManifest {
  version: number;
  attribution?: string;
  avatars: AvatarManifestEntry[];
  anim_libraries?: { id: string; sex: 'f' | 'm'; glb: string; clips: string[] }[];
}

/** Clip names in anims-f.glb and anims-m.glb. */
export const CLIPS = {
  breathe: 'sit_table_breathe_01',
  idle1: 'idle_neutral_01',
  idle2: 'idle_neutral_02',
  thoughtful: 'gestic_thoughtful',
  accept1: 'gestic_listen_accept_01',
  accept2: 'gestic_listen_accept_02',
  accept3: 'gestic_listen_accept_03',
  touchFace: 'idle_touch_face',
} as const;
