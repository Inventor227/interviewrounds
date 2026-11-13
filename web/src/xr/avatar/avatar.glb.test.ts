// @vitest-environment node
// The runtime on the real converted avatar (f01) and its clip library: geometry and clips decode with meshopt in
// Node, KTX2 textures are stubbed (no GPU here). Checks the head pose stays sane in every mode, and times update().

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Quaternion, Texture, Vector3, type Object3D } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { describe, expect, it } from 'vitest';
import { Avatar } from './avatar';
import { DEG } from './gaze';
import type { AvatarManifest } from './types';

// The loaders look for a browser global.
(globalThis as { self?: unknown }).self ??= globalThis;

const PUB = path.join(__dirname, '..', '..', '..', 'public');

const ktx2Stub = {
  load(_url: string, onLoad: (t: Texture) => void) {
    onLoad(new Texture());
  },
  dispose() {},
};

function parse(file: string): Promise<GLTF> {
  const buf = readFileSync(path.join(PUB, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  (loader as unknown as { setKTX2Loader(l: unknown): void }).setKTX2Loader(ktx2Stub);
  return new Promise((res, rej) => loader.parse(ab, '', res, rej));
}

async function load(id = 'f01', seed = 9) {
  const manifest = JSON.parse(readFileSync(path.join(PUB, 'avatars', 'manifest.json'), 'utf8')) as AvatarManifest;
  const entry = manifest.avatars.find((a) => a.id === id)!;
  const [g, anims] = await Promise.all([parse(entry.glb.slice(1)), parse(entry.anims.slice(1))]);
  const a = Avatar.fromModel(entry, g.scene, anims.animations, { seed });
  a.place({ position: { x: 0, y: 0, z: 0 }, yaw: 0, deskY: 0.74 });
  return { a, entry, model: g.scene };
}

/** Head yaw (toward +X), pitch (up) and roll of the head bone, from its bind-pose axes. */
function headPose(head: Object3D, bindInv: Quaternion) {
  const q = head.getWorldQuaternion(new Quaternion()).multiply(bindInv);
  const f = new Vector3(0, 0, 1).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  return {
    yaw: Math.atan2(f.x, f.z),
    pitch: Math.atan2(f.y, Math.hypot(f.x, f.z)),
    roll: Math.atan2(-up.x, up.y),
  };
}

describe('avatar on the real rig', () => {
  it('head_stays_near_the_user_in_every_mode', async () => {
    const { a, entry, model } = await load();
    const head = model.getObjectByName(entry.head_bone)!;
    model.updateMatrixWorld(true);
    const bindInv = head.getWorldQuaternion(new Quaternion()).invert();
    const user = new Vector3(0, 1.2, 1.45);
    a.lookAt(user);
    const worst: Record<string, { yaw: number; pitch: number; roll: number }> = {};
    // Conversation modes for 20 s; thinking for 2 s (it moves to the hand-to-chin clip after 2.5 s on purpose).
    for (const [mode, secs] of [
      ['listening', 20],
      ['thinking', 2],
      ['speaking', 20],
      ['listening', 20],
    ] as const) {
      a.setMode(mode);
      const w = { yaw: 0, pitch: 0, roll: 0 };
      for (let i = 0; i < 72 * secs; i++) {
        a.update(1 / 72);
        if (i % 6) continue;
        model.updateMatrixWorld(true);
        const p = headPose(head, bindInv);
        w.yaw = Math.max(w.yaw, Math.abs(p.yaw));
        w.pitch = Math.max(w.pitch, Math.abs(p.pitch));
        w.roll = Math.max(w.roll, Math.abs(p.roll));
      }
      worst[`${mode}${worst[mode] ? '2' : ''}`] = { yaw: w.yaw / DEG, pitch: w.pitch / DEG, roll: w.roll / DEG };
    }
    process.stderr.write(`worst head pose (deg) ${JSON.stringify(worst)}\n`);
    for (const m of Object.values(worst)) {
      // The user is straight ahead and a little below: the head stays within glances and clip motion of them.
      expect(m.yaw).toBeLessThan(14);
      expect(m.roll).toBeLessThan(10);
      expect(m.pitch).toBeLessThan(25);
    }
  }, 60000);

  it('point_at_moves_the_hand_toward_the_target', async () => {
    const { a, model } = await load('f01', 2);
    a.lookAt(new Vector3(0, 1.2, 1.45));
    a.setMode('listening');
    for (let i = 0; i < 72; i++) a.update(1 / 72);
    const hand = model.getObjectByName('Bip01_R_Hand')!;
    model.updateMatrixWorld(true);
    const before = hand.getWorldPosition(new Vector3());
    // A board to the avatar's right (-X), at head height.
    const board = new Vector3(-1.05, 1.35, 0.55);
    a.pointAt(board, 2);
    for (let i = 0; i < 72; i++) a.update(1 / 72);
    model.updateMatrixWorld(true);
    const during = hand.getWorldPosition(new Vector3());
    process.stderr.write(`hand before ${before.toArray().map((v) => v.toFixed(2))} during ${during.toArray().map((v) => v.toFixed(2))}\n`);
    expect(during.distanceTo(board)).toBeLessThan(before.distanceTo(board) - 0.15);
    expect(during.y).toBeGreaterThan(before.y + 0.05);
    // Released after the hold.
    for (let i = 0; i < 72 * 2; i++) a.update(1 / 72);
    model.updateMatrixWorld(true);
    expect(hand.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(0.08);
  }, 60000);

  it('update_cost_per_avatar', async () => {
    const { a } = await load('m02', 4);
    a.lookAt(new Vector3(0, 1.2, 1.45));
    const res: Record<string, { mean: number; p95: number }> = {};
    for (const mode of ['idle', 'listening', 'thinking', 'speaking'] as const) {
      a.setMode(mode);
      for (let i = 0; i < 144; i++) a.update(1 / 72);
      const t: number[] = [];
      for (let i = 0; i < 1440; i++) {
        const t0 = performance.now();
        a.update(1 / 72);
        t.push(performance.now() - t0);
      }
      t.sort((x, y) => x - y);
      res[mode] = { mean: t.reduce((s, x) => s + x, 0) / t.length, p95: t[Math.floor(t.length * 0.95)]! };
    }
    process.stderr.write(`update cost (ms) ${JSON.stringify(res)}\n`);
    // Loose guard here (shared CI machines); the report holds the measured numbers against the 0.4 ms budget.
    for (const r of Object.values(res)) expect(r.mean).toBeLessThan(1.5);
  }, 60000);
});
