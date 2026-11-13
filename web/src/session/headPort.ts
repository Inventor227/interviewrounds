// The head sampler as the round controller sees it: 5 samples a second while the round runs,
// taken on the room's frames, batched to the socket. Times are wall clock (ms since the epoch),
// like every other client time on the socket.

import type { HeadSample } from '../shared/types';
import type { HeadSamplerPort } from './ports';

export interface HeadPoseLike {
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
}

export interface GazeTargetLike {
  id: string;
  pos: { x: number; y: number; z: number };
  coneDeg?: number;
}

/** The sampler itself (xr/head.ts HeadSampler). */
export interface SamplerLike {
  setTargets(floorId: string | null, targets: GazeTargetLike[]): void;
  setFloor(floorId: string | null): void;
  tick(t_ms: number, head: HeadPoseLike, speaking: boolean): unknown;
  flush(): void;
}

export interface HeadPortDeps {
  makeSampler(send: (samples: HeadSample[]) => void): SamplerLike;
  onFrame(cb: (dt: number, nowMs: number) => void): () => void;
  headPose(): HeadPoseLike;
  /** Everyone and everything worth looking at, right now (people's eyes, the sheet). */
  targets(): GazeTargetLike[];
  /** Also told when the user starts or stops talking (the avatars nod at pauses). */
  onUserSpeaking?(speaking: boolean): void;
  now?: () => number;
}

export function createHeadPort(deps: HeadPortDeps): HeadSamplerPort {
  const now = deps.now ?? Date.now;
  let sampler: SamplerLike | null = null;
  let off: (() => void) | null = null;
  let floor: string | null = null;
  let speaking = false;
  return {
    start(sink) {
      if (sampler) return;
      const s = deps.makeSampler(sink);
      sampler = s;
      s.setTargets(floor, deps.targets());
      off = deps.onFrame(() => s.tick(now(), deps.headPose(), speaking));
    },
    stop() {
      off?.();
      off = null;
      sampler?.flush();
      sampler = null;
    },
    setUserSpeaking(b) {
      speaking = b;
      deps.onUserSpeaking?.(b);
    },
    setFloor(id) {
      floor = id;
      // Seats can change with the floor (a late avatar, a re-placed desk): refresh the targets.
      sampler?.setTargets(id, deps.targets());
    },
  };
}
