// Head sampler: 5 times a second, where the user's head points relative to the panelist holding the floor, and who
// (if anyone) they are looking at. Batches go to the socket every 5 s as `head.samples`; the scorer turns them into
// "eye contact with the speaker".
//
// Sample fields (docs/protocol.md `head.samples`): yaw and pitch are degrees, the head's direction minus the
// direction to the floor panelist's eyes (positive yaw = to their left, as the user sees it; positive pitch = above).
// With no floor panelist they are the head's own yaw and pitch. `target` is the id of the panelist within 15° of the
// head's direction (closest wins), else the id of another named target (e.g. 'sheet', 'wallboard'), else null.

import type { HeadSample } from '../shared/types';
import { angleBetween, DEG, pitchLooking, sub, viewDir, wrapAngle, yawLooking, type Vec3 } from './math';
import type { HeadPose } from './placement';

export interface GazeTarget {
  id: string;
  pos: Vec3;
  /** Cone half-angle in degrees for this target (default 15). */
  coneDeg?: number;
}

export interface HeadSamplerOptions {
  send: (samples: HeadSample[]) => void;
  hz?: number;
  batchMs?: number;
  coneDeg?: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export class HeadSampler {
  private readonly periodMs: number;
  private readonly batchMs: number;
  private readonly coneDeg: number;
  private nextAt: number | null = null;
  private batchStart: number | null = null;
  private buf: HeadSample[] = [];
  private floorId: string | null = null;
  private targets: GazeTarget[] = [];

  constructor(private readonly opts: HeadSamplerOptions) {
    this.periodMs = 1000 / (opts.hz ?? 5);
    this.batchMs = opts.batchMs ?? 5000;
    this.coneDeg = opts.coneDeg ?? 15;
  }

  /** Who holds the floor, and the head positions of everyone (and anything) worth looking at. */
  setTargets(floorId: string | null, targets: GazeTarget[]): void {
    this.floorId = floorId;
    this.targets = targets.map((t) => ({ ...t, pos: { ...t.pos } }));
  }

  setFloor(floorId: string | null): void {
    this.floorId = floorId;
  }

  /** Call every frame; returns the sample when one was taken. */
  tick(t_ms: number, head: HeadPose, speaking: boolean): HeadSample | null {
    if (this.nextAt !== null && t_ms < this.nextAt) return null;
    this.nextAt = this.nextAt === null || t_ms - this.nextAt > this.periodMs ? t_ms + this.periodMs : this.nextAt + this.periodMs;
    const sample = this.measure(t_ms, head, speaking);
    if (this.batchStart === null) this.batchStart = t_ms;
    this.buf.push(sample);
    if (t_ms - this.batchStart >= this.batchMs) this.flush();
    return sample;
  }

  /** Sends what is buffered (round end, pause). */
  flush(): void {
    if (this.buf.length === 0) {
      this.batchStart = null;
      return;
    }
    const out = this.buf;
    this.buf = [];
    this.batchStart = null;
    this.opts.send(out);
  }

  private measure(t_ms: number, head: HeadPose, speaking: boolean): HeadSample {
    const floor = this.targets.find((t) => t.id === this.floorId) ?? null;
    let yaw = head.yaw;
    let pitch = head.pitch;
    if (floor) {
      const d = sub(floor.pos, head.pos);
      yaw = wrapAngle(head.yaw - yawLooking(d));
      pitch = head.pitch - pitchLooking(d);
    }
    const look = viewDir(head.yaw, head.pitch);
    let target: string | null = null;
    let best = Infinity;
    for (const t of this.targets) {
      const a = angleBetween(look, sub(t.pos, head.pos)) / DEG;
      if (a <= (t.coneDeg ?? this.coneDeg) && a < best) {
        best = a;
        target = t.id;
      }
    }
    return { t_ms: Math.round(t_ms), yaw: round1(yaw / DEG), pitch: round1(pitch / DEG), speaking, target };
  }
}
