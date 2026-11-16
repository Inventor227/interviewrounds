// Build-time content versions of the big public files, served to the app as `virtual:ir-static`:
// { "/avatars/m02.glb": { v: <first 16 hex of SHA-256>, bytes }, ... }. The app asks for them as `?v=<v>`, and the
// server keeps such a response cached for a year only when the version is its file's (server/src/static_files.rs),
// so a second round loads them from the browser cache and a deploy that changes a file is picked up at once.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Folders under public/ whose files are versioned. */
export const VERSIONED_DIRS = ['avatars', 'vendor/basis'];
const VERSIONED_FILE = /\.(glb|wasm|js)$/;
const ID = 'virtual:ir-static';

export function versionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function staticVersionList(publicDir: string): Record<string, { v: string; bytes: number }> {
  const out: Record<string, { v: string; bytes: number }> = {};
  for (const dir of VERSIONED_DIRS) {
    for (const f of readdirSync(path.join(publicDir, dir)).sort()) {
      if (!VERSIONED_FILE.test(f)) continue;
      const bytes = readFileSync(path.join(publicDir, dir, f));
      out[`/${dir}/${f}`] = { v: versionOf(bytes), bytes: bytes.length };
    }
  }
  return out;
}

export function staticVersions(publicDir = fileURLToPath(new URL('./public', import.meta.url))): Plugin {
  return {
    name: 'ir:static-versions',
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load: (id) => (id === `\0${ID}` ? `export default ${JSON.stringify(staticVersionList(publicDir))};` : null),
  };
}
