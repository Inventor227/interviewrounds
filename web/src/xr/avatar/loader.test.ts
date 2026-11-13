import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The served Basis transcoder must match the installed three (KTX2Loader and the transcoder are versioned together).
describe('loader', () => {
  it('basis_transcoder_copy_matches_three', () => {
    const require = createRequire(import.meta.url);
    const three = path.dirname(require.resolve('three'));
    const lib = path.join(three, '..', 'examples', 'jsm', 'libs', 'basis');
    const pub = path.join(__dirname, '..', '..', '..', 'public', 'vendor', 'basis');
    for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm'])
      expect(readFileSync(path.join(pub, f)).equals(readFileSync(path.join(lib, f))), f).toBe(true);
  });
});
