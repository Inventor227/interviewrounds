// Loading avatars and their clip libraries.
//
// The avatar GLBs use meshopt geometry and KTX2 (Basis) textures, which IWSDK's own glTF loader does not decode
// with its defaults, so we keep our own GLTFLoader with MeshoptDecoder and KTX2Loader. KTX2Loader in this three
// build locates its transcoder with import.meta.url, so Vite bundles it and nothing is fetched from a CDN.

import type { AnimationClip, WebGLRenderer } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { AvatarManifest, AvatarManifestEntry } from './types';

export const MANIFEST_URL = '/avatars/manifest.json';

let loader: GLTFLoader | null = null;
let ktx2: KTX2Loader | null = null;
const clipLibs = new Map<string, Promise<AnimationClip[]>>();
let manifest: Promise<AvatarManifest> | null = null;

/** Sets up the shared loader for this renderer (KTX2 needs it to pick a GPU format). Safe to call again. */
export function configureAvatarLoader(renderer: WebGLRenderer): GLTFLoader {
  if (loader) return loader;
  ktx2 = new KTX2Loader().detectSupport(renderer);
  loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  return loader;
}

function need(): GLTFLoader {
  if (!loader) throw new Error('call configureAvatarLoader(renderer) or pass { renderer } before loading avatars');
  return loader;
}

export function loadAvatarGltf(entry: AvatarManifestEntry): Promise<GLTF> {
  return need().loadAsync(entry.glb);
}

/** The clip library for a sex, loaded once and shared by every avatar of that sex. */
export function loadClips(url: string): Promise<AnimationClip[]> {
  let p = clipLibs.get(url);
  if (!p) {
    p = need()
      .loadAsync(url)
      .then((g) => g.animations);
    clipLibs.set(url, p);
    p.catch(() => clipLibs.delete(url));
  }
  return p;
}

export function loadManifest(url = MANIFEST_URL): Promise<AvatarManifest> {
  if (!manifest) {
    manifest = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`avatar manifest: HTTP ${r.status}`);
      return r.json() as Promise<AvatarManifest>;
    });
    manifest.catch(() => (manifest = null));
  }
  return manifest;
}

export async function manifestEntry(id: string, url = MANIFEST_URL): Promise<AvatarManifestEntry> {
  const m = await loadManifest(url);
  const e = m.avatars.find((a) => a.id === id);
  if (!e) throw new Error(`avatar ${id} is not in the manifest`);
  return e;
}
