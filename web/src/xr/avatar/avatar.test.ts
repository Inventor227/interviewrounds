import { Bone, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Avatar, CLIP_DESK_Y } from './avatar';
import { DEG } from './gaze';
import { VISEMES } from './lipsync';
import type { AvatarManifestEntry } from './types';

// A synthetic Biped-like rig: identity bone rotations, so every bone faces the avatar's +Z, plus one mesh with
// the morph targets the runtime drives.
const MORPHS = [
  ...VISEMES,
  'jawOpen',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'eyeSquintLeft',
  'eyeSquintRight',
];

function rig(): Group {
  const scene = new Group();
  const b = (name: string, parent: Bone | Group, x: number, y: number, z: number) => {
    const o = new Bone();
    o.name = name;
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };
  const root = b('Bip01', scene, 0, 0.9, 0);
  const pelvis = b('Bip01_Pelvis', root, 0, 0, 0);
  const spine = b('Bip01_Spine', pelvis, 0, 0.1, 0);
  const spine2 = b('Bip01_Spine2', spine, 0, 0.25, 0);
  const neck = b('Bip01_Neck', spine2, 0, 0.15, 0);
  const head = b('Bip01_Head', neck, 0, 0.08, 0);
  b('Bip01_LEye', head, 0.03, 0.08, 0.08);
  b('Bip01_REye', head, -0.03, 0.08, 0.08);
  for (const [s, x] of [
    ['L', 1],
    ['R', -1],
  ] as const) {
    const cl = b(`Bip01_${s}_Clavicle`, neck, 0.05 * x, -0.02, 0);
    const up = b(`Bip01_${s}_UpperArm`, cl, 0.12 * x, 0, 0);
    const fore = b(`Bip01_${s}_Forearm`, up, 0, -0.28, 0);
    b(`Bip01_${s}_Hand`, fore, 0, 0, 0.26);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
  g.morphAttributes.position = MORPHS.map((name) => {
    const a = new Float32BufferAttribute(new Float32Array(9), 3);
    a.name = name;
    return a;
  });
  const mesh = new Mesh(g, new MeshBasicMaterial());
  mesh.updateMorphTargets();
  scene.add(mesh);
  return scene;
}

const entry: AvatarManifestEntry = {
  id: 't01',
  sex: 'f',
  glb: '',
  anims: '',
  height_m: 1.7,
  eye_bone: 'Bip01_LEye',
  eye_bones: ['Bip01_LEye', 'Bip01_REye'],
  head_bone: 'Bip01_Head',
  morphs: MORPHS,
};

function make(seed = 1) {
  const model = rig();
  const a = Avatar.fromModel(entry, model, [], { seed });
  const mesh = model.children.find((c) => c instanceof Mesh) as Mesh;
  return { a, model, mesh };
}

const run = (a: Avatar, s: number) => {
  for (let i = 0; i < Math.round(s * 72); i++) a.update(1 / 72);
};

/** Yaw and pitch of a bone's +Z in world space. */
function aim(o: Bone) {
  const q = o.getWorldQuaternion(new Quaternion());
  const d = new Vector3(0, 0, 1).applyQuaternion(q);
  return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}

describe('avatar', () => {
  it('avatar_place_sets_hands_on_the_desk', () => {
    const { a } = make();
    a.place({ position: { x: 1, y: 5, z: -2 }, yaw: Math.PI / 2, deskY: 0.8 });
    expect(a.root.position.x).toBeCloseTo(1);
    expect(a.root.position.y).toBeCloseTo(0.8 - CLIP_DESK_Y);
    expect(a.root.position.z).toBeCloseTo(-2);
    expect(a.root.rotation.y).toBeCloseTo(Math.PI / 2);
  });

  it('avatar_head_turn_is_clamped_and_eyes_reach_the_target', () => {
    const { a, model } = make();
    a.place({ position: { x: 0, y: 0, z: 0 }, yaw: 0, deskY: CLIP_DESK_Y });
    a.setMode('speaking');
    // Far to the avatar's left at eye height: the head stops at 35°.
    a.lookAt(new Vector3(3, 1.48, 0.6));
    run(a, 3);
    model.updateMatrixWorld(true);
    const head = aim(model.getObjectByName('Bip01_Head') as Bone);
    expect(head.yaw).toBeGreaterThan(30 * DEG);
    expect(head.yaw).toBeLessThanOrEqual(37 * DEG);
    // 20° to the side: the head turns most of the way and the eyes land on the target.
    a.setMode('listening');
    const target = new Vector3(Math.sin(20 * DEG) * 1.2, 1.48, Math.cos(20 * DEG) * 1.2);
    a.lookAt(target);
    run(a, 2);
    model.updateMatrixWorld(true);
    const eye = model.getObjectByName('Bip01_LEye') as Bone;
    const e = aim(eye);
    const want = Math.atan2(target.x - eye.getWorldPosition(new Vector3()).x, target.z - eye.getWorldPosition(new Vector3()).z);
    // Within micro-saccade range (2°) plus a little head sway.
    expect(Math.abs(e.yaw - want)).toBeLessThan(3.5 * DEG);
  });

  it('avatar_thinking_looks_up', () => {
    const { a, model } = make(3);
    a.place({ position: { x: 0, y: 0, z: 0 }, yaw: 0, deskY: CLIP_DESK_Y });
    a.lookAt(new Vector3(0, 1.48, 1.2));
    run(a, 1);
    a.setMode('thinking');
    run(a, 0.3);
    model.updateMatrixWorld(true);
    const e = aim(model.getObjectByName('Bip01_REye') as Bone);
    expect(e.pitch).toBeGreaterThan(6 * DEG);
  });

  it('avatar_morphs_are_written_only_when_they_change', () => {
    const { a, mesh } = make(5);
    a.place({ position: { x: 0, y: 0, z: 0 }, yaw: 0, deskY: CLIP_DESK_Y });
    a.lookAt(new Vector3(0, 1.48, 1.2));
    run(a, 3);
    // A settled face: most frames write nothing (only blinks and lids move).
    let idle = 0;
    for (let i = 0; i < 144; i++) {
      a.update(1 / 72);
      if (a.stats.morphWrites === 0) idle++;
    }
    expect(idle).toBeGreaterThan(100);
    // The listening face shows on the shared influences.
    a.setMode('listening');
    run(a, 2);
    const i = mesh.morphTargetDictionary!.mouthSmileLeft!;
    expect(mesh.morphTargetInfluences![i]).toBeGreaterThan(0.1);
    expect(a.isSpeaking).toBe(false);
    expect(a.voiceLevel).toBe(0);
  });
});
