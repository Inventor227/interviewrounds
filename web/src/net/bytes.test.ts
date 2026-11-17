import { afterEach, describe, expect, it, vi } from 'vitest';
import versions from 'virtual:ir-static';
import { bytesProgress, fetchBytes, knownSize, onBytes, resetBytes, takeBytes, versioned } from './bytes';

afterEach(() => {
  resetBytes();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A response whose body arrives in the given chunks. */
function chunked(parts: number[], headers: Record<string, string> = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < parts.length) c.enqueue(new Uint8Array(parts[i++]!).fill(7));
      else c.close();
    },
  });
  return new Response(body, { headers });
}

describe('bytes', () => {
  it('versions_come_from_the_build_list_of_public_files', () => {
    const f = versions['/avatars/m02.glb'];
    expect(f?.v).toMatch(/^[0-9a-f]{16}$/);
    expect(versioned('/avatars/m02.glb')).toBe(`/avatars/m02.glb?v=${f!.v}`);
    expect(knownSize(versioned('/avatars/m02.glb'))).toBe(f!.bytes);
    expect(versions['/vendor/basis/basis_transcoder.wasm']).toBeTruthy();
    expect(versions['/vendor/basis/ktx2_worker.js']).toBeTruthy();
    // Files the build does not list keep their plain URL.
    expect(versioned('/avatars/manifest.json')).toBe('/avatars/manifest.json');
    expect(knownSize('/nope.bin')).toBeNull();
  });

  it('one_download_per_file_with_progress_then_handed_over_once', async () => {
    const fetch = vi.fn(async () => chunked([10, 20, 30], { 'content-length': '60' }));
    vi.stubGlobal('fetch', fetch);
    const a = fetchBytes('/x.bin');
    const b = fetchBytes('/x.bin');
    expect(fetch).toHaveBeenCalledTimes(1);
    // The size is known once the response starts (no build size for this file).
    expect(bytesProgress(['/x.bin'])).toEqual({ loaded: 0, total: null });
    const buf = await a;
    expect(await b).toBe(buf);
    expect(buf.byteLength).toBe(60);
    expect(bytesProgress(['/x.bin'])).toEqual({ loaded: 60, total: 60 });

    expect(await takeBytes('/x.bin')).toBe(buf);
    await Promise.resolve();
    // Handed over: forgotten (a later round reads it from the HTTP cache) but still counted as loaded.
    expect(takeBytes('/x.bin')).toBeNull();
    expect(bytesProgress(['/x.bin'])).toEqual({ loaded: 60, total: 60 });
  });

  it('compressed_responses_use_the_known_size_not_content_length', async () => {
    const url = versioned('/avatars/anims-m.glb');
    const size = knownSize(url)!;
    vi.stubGlobal('fetch', async () => chunked([size], { 'content-encoding': 'br', 'content-length': '5' }));
    expect(bytesProgress([url])).toEqual({ loaded: 0, total: size });
    await fetchBytes(url);
    expect(bytesProgress([url])).toEqual({ loaded: size, total: size });
  });

  it('unknown_sizes_make_the_total_unknown_and_unstarted_files_count_nothing', () => {
    expect(bytesProgress(['/a.bin'])).toEqual({ loaded: 0, total: null });
    const url = versioned('/avatars/m02.glb');
    expect(bytesProgress([url])).toEqual({ loaded: 0, total: knownSize(url) });
  });

  it('a_failed_download_is_forgotten_so_the_next_call_tries_again', async () => {
    let fail = true;
    vi.stubGlobal('fetch', async () => (fail ? new Response('x', { status: 503 }) : chunked([4])));
    await expect(fetchBytes('/f.bin')).rejects.toThrow(/503/);
    await Promise.resolve();
    fail = false;
    expect((await fetchBytes('/f.bin')).byteLength).toBe(4);
  });

  it('listeners_hear_about_progress_in_batches', async () => {
    vi.stubGlobal('fetch', async () => chunked([1, 1, 1, 1]));
    const cb = vi.fn();
    const off = onBytes(cb);
    await fetchBytes('/b.bin');
    await new Promise((r) => setTimeout(r, 80));
    expect(cb.mock.calls.length).toBeGreaterThan(0);
    expect(cb.mock.calls.length).toBeLessThan(4);
    off();
  });
});
