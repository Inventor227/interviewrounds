// Which files an avatar needs, and fetching them ahead. No three.js here: the 2D pages import this to start a
// round's downloads before the tap, and the loader picks the bytes up (net/bytes.ts).

import { fetchBytes, versioned } from '../../net/bytes';
import type { AvatarManifest, AvatarManifestEntry } from './types';

export const MANIFEST_URL = '/avatars/manifest.json';
export const BASIS_PATH = '/vendor/basis/';
/** The texture transcoder every avatar needs (its worker script is small and loads on its own). */
export const TRANSCODER_FILES = [`${BASIS_PATH}basis_transcoder.js`, `${BASIS_PATH}basis_transcoder.wasm`];

let manifest: Promise<AvatarManifest> | null = null;

export function loadManifest(url = MANIFEST_URL): Promise<AvatarManifest> {
  if (!manifest) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`avatar manifest: HTTP ${r.status}`);
      return r.json() as Promise<AvatarManifest>;
    });
    p.catch(() => {
      if (manifest === p) manifest = null;
    });
    manifest = p;
  }
  return manifest;
}

export async function manifestEntry(id: string, url = MANIFEST_URL): Promise<AvatarManifestEntry> {
  const m = await loadManifest(url);
  const e = m.avatars.find((a) => a.id === id);
  if (!e) throw new Error(`avatar ${id} is not in the manifest`);
  return e;
}

/** The versioned URLs an avatar loads: its model and its clip library. */
export function avatarFiles(entry: AvatarManifestEntry): string[] {
  return [versioned(entry.glb), versioned(entry.anims)];
}

/** Every file a room with these avatars downloads (models, clips, transcoder), versioned, without repeats. */
export async function roomFiles(avatarIds: readonly string[]): Promise<string[]> {
  const entries = await Promise.all(avatarIds.map((id) => manifestEntry(id)));
  return [...new Set([...entries.flatMap(avatarFiles), ...TRANSCODER_FILES.map(versioned)])];
}

/** Starts downloading what these avatars need. Never rejects; the room loads anything missing itself. */
export async function prefetchAvatars(avatarIds: readonly string[]): Promise<void> {
  try {
    const urls = await roomFiles(avatarIds);
    await Promise.all(urls.map((u) => fetchBytes(u).catch(() => undefined)));
  } catch {
    // The manifest did not load: the room tries again when it loads.
  }
}
