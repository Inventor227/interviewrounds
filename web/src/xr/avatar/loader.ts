// Loading avatars and their clip libraries.
//
// The avatar GLBs use meshopt geometry and KTX2 (Basis) textures, which IWSDK's own glTF loader does not decode
// with its defaults, so we keep our own GLTFLoader with MeshoptDecoder and KTX2Loader. The Basis transcoder is served
// from /vendor/basis/ (a copy of three's, pinned by a test). KTX2Loader's own default finds it with
// import.meta.url, which breaks under the Vite dev server: three is pre-bundled there, the URL 404s, the SPA answers
// with index.html and the transcoder worker never starts. IWSDK's default would fetch it from a CDN. Its workers
// start from /vendor/basis/ktx2_worker.js, not a blob (see ktx2.ts: the page's CSP would stop them).
//
// Every file comes through the shared byte cache (net/bytes.ts) under its versioned URL: a page may have fetched it
// before the tap, and the room shows download progress from it.

import type { AnimationClip, WebGLRenderer } from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { fetchBytes, takeBytes, versioned } from '../../net/bytes';
import { BASIS_PATH } from './files';
import { KTX2_WORKER_URL, OwnWorkerKTX2Loader } from './ktx2';
import type { AvatarManifestEntry } from './types';

export { BASIS_PATH, MANIFEST_URL, loadManifest, manifestEntry } from './files';

let loader: GLTFLoader | null = null;
let ktx2: KTX2Loader | null = null;
const clipLibs = new Map<string, Promise<AnimationClip[]>>();

/** Sets up the shared loader for this renderer (KTX2 needs it to pick a GPU format). Safe to call again. */
export function configureAvatarLoader(renderer: WebGLRenderer): GLTFLoader {
  if (loader) return loader;
  ktx2 = new OwnWorkerKTX2Loader({
    js: versioned(`${BASIS_PATH}basis_transcoder.js`),
    wasm: versioned(`${BASIS_PATH}basis_transcoder.wasm`),
    worker: versioned(KTX2_WORKER_URL),
  }).detectSupport(renderer);
  // The transcoder downloads now, alongside the models, not after the first model is in.
  void ktx2.init().catch(() => undefined);
  loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  return loader;
}

function need(): GLTFLoader {
  if (!loader) throw new Error('call configureAvatarLoader(renderer) or pass { renderer } before loading avatars');
  return loader;
}

/** A GLB by its plain URL: its bytes from the shared cache (fetched ahead or now), then parsed. */
async function loadGlb(url: string): Promise<GLTF> {
  const l = need();
  const v = versioned(url);
  void fetchBytes(v).catch(() => undefined);
  let bytes: ArrayBuffer;
  try {
    bytes = await takeBytes(v)!;
  } catch {
    // The download failed: one more try the loader's own way (its error is the one callers see).
    return l.loadAsync(v);
  }
  return l.parseAsync(bytes, url.slice(0, url.lastIndexOf('/') + 1));
}

export function loadAvatarGltf(entry: AvatarManifestEntry): Promise<GLTF> {
  return loadGlb(entry.glb);
}

/** The clip library for a sex, loaded once and shared by every avatar of that sex. */
export function loadClips(url: string): Promise<AnimationClip[]> {
  let p = clipLibs.get(url);
  if (!p) {
    p = loadGlb(url).then((g) => g.animations);
    clipLibs.set(url, p);
    p.catch(() => clipLibs.delete(url));
  }
  return p;
}
