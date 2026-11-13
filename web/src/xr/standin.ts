// Stand-in people for framing the seats in screenshots and the preview, until the avatar runtime takes over the
// seats. Loads a converted avatar and plays the seated breathing clip; no gaze, blinks or lip sync here.

import { AnimationMixer, type Object3D, type WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { BodyDetail, bodyMesh, slimAvatar } from './avatar/slim';
import type { SeatPose } from './seats';

export const DEFAULT_STANDINS = ['m04', 'f01', 'm02'];

export interface StandIn {
  id: string;
  object: Object3D;
  mixer: AnimationMixer;
  /** Full body on the lead seat, simplified on the others (as the round's avatars). */
  detail?: BodyDetail;
}

let loader: GLTFLoader | null = null;
function getLoader(renderer: WebGLRenderer): GLTFLoader {
  if (loader) return loader;
  // KTX2Loader finds its transcoder next to itself (bundled by Vite), so nothing loads from a CDN.
  const ktx2 = new KTX2Loader().detectSupport(renderer);
  loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  return loader;
}

export async function loadStandIn(renderer: WebGLRenderer, id: string, base = '/avatars/'): Promise<StandIn> {
  const l = getLoader(renderer);
  const sex = id.startsWith('f') ? 'f' : 'm';
  const [avatar, anims] = await Promise.all([l.loadAsync(`${base}${id}.glb`), l.loadAsync(`${base}anims-${sex}.glb`)]);
  const object = avatar.scene;
  object.name = `standin-${id}`;
  // Seated like the round's avatars: no legs under the table, no morph shapes that never move.
  slimAvatar(object);
  object.traverse((o) => {
    (o as { frustumCulled?: boolean }).frustumCulled = false;
  });
  const mixer = new AnimationMixer(object);
  const clip = anims.animations.find((c) => c.name === 'sit_table_breathe_01') ?? anims.animations[0];
  if (clip) {
    mixer.clipAction(clip).play();
    mixer.setTime(2 + Math.random());
  }
  return { id, object, mixer, detail: new BodyDetail(bodyMesh(object)) };
}

export function placeStandIn(s: StandIn, seat: SeatPose): void {
  s.object.position.set(seat.pos.x, seat.pos.y, seat.pos.z);
  s.object.rotation.set(0, seat.yaw, 0);
  void s.detail?.set(seat.seat === 0 ? 0 : 1).catch(() => undefined);
}
