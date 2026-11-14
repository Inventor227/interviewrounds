// Public surface of the avatar runtime.
export { Avatar, CLIP_DESK_Y, type AvatarOptions, type AvatarStats } from './avatar';
export { configureAvatarLoader, loadManifest, manifestEntry, MANIFEST_URL } from './loader';
export { LipSync, type LipSyncEngine } from './lipsync';
export { gazeTarget } from './gaze';
export { nextBlinkMs } from './blink';
export { warmSimplifier } from './slim';
export type { AvatarManifest, AvatarManifestEntry, AvatarMode, Mood, SeatPose, Vec3Like } from './types';
