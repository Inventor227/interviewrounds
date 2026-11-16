import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KTX2_WORKER_URL, OwnWorkerKTX2Loader, ktx2WorkerSource } from './ktx2';

const BOOT_FILE = path.join(__dirname, '..', '..', '..', 'public', 'vendor', 'basis', 'ktx2_worker.js');

class FakeWorker {
  static made: FakeWorker[] = [];
  readonly sent: { msg: { type: string; source?: string; transcoderBinary?: ArrayBuffer }; transfer?: Transferable[] }[] = [];
  constructor(readonly url: string) {
    FakeWorker.made.push(this);
  }
  postMessage(msg: FakeWorker['sent'][number]['msg'], transfer?: Transferable[]) {
    this.sent.push({ msg, transfer });
  }
  addEventListener() {}
  terminate() {}
}

afterEach(() => {
  FakeWorker.made = [];
  vi.unstubAllGlobals();
});

describe('ktx2', () => {
  it('worker_source_is_three_worker_code_around_the_transcoder', () => {
    const src = ktx2WorkerSource('var BASIS = function () {};');
    expect(src).toContain('var BASIS = function () {};');
    expect(src).toMatch(/let _EngineFormat = \{/);
    // three's worker body: it answers 'init' and 'transcode'.
    expect(src).toContain("case 'init'");
    expect(src).toContain("case 'transcode'");
    expect(src.indexOf('var BASIS')).toBeLessThan(src.indexOf("case 'init'"));
  });

  it('workers_start_from_the_same_origin_script_and_get_boot_then_init', async () => {
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer;
    const fetched: string[] = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request | string) => {
        const url = typeof req === 'string' ? req : req.url;
        fetched.push(url);
        return url.endsWith('.wasm') ? new Response(wasm) : new Response('var BASIS = function () {};');
      }),
    );
    const loader = new OwnWorkerKTX2Loader().setTranscoderPath('http://localhost/vendor/basis/');
    await loader.init();
    expect(fetched.map((u) => u.replace('http://localhost', ''))).toEqual(['/vendor/basis/basis_transcoder.js', '/vendor/basis/basis_transcoder.wasm']);

    // The pool makes its workers on demand; make one the way it would.
    const create = (loader.workerPool as unknown as { workerCreator: () => Worker }).workerCreator;
    create();
    const w = FakeWorker.made[0]!;
    expect(w.url).toBe(KTX2_WORKER_URL);
    expect(w.sent.map((s) => s.msg.type)).toEqual(['boot', 'init']);
    expect(w.sent[0]!.msg.source).toContain('var BASIS = function () {};');
    expect(w.sent[1]!.msg.transcoderBinary!.byteLength).toBe(wasm.byteLength);
    // Each worker gets its own copy of the transcoder (it is transferred).
    expect(w.sent[1]!.transfer).toEqual([w.sent[1]!.msg.transcoderBinary]);
  });

  it('a_failed_download_can_be_tried_again', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (fail ? new Response('no', { status: 503 }) : new Response('var BASIS;'))),
    );
    const loader = new OwnWorkerKTX2Loader().setTranscoderPath('http://localhost/vendor/basis/');
    await expect(loader.init()).rejects.toBeTruthy();
    fail = false;
    await expect(loader.init()).resolves.toBeUndefined();
  });

  it('boot_script_runs_the_sent_source_once_then_steps_aside', () => {
    const code = readFileSync(BOOT_FILE, 'utf8');
    const listeners = new Set<(e: { data: unknown }) => void>();
    const fakeSelf = {
      addEventListener: (_: string, l: (e: { data: unknown }) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (e: { data: unknown }) => void) => listeners.delete(l),
    };
    new Function('self', code)(fakeSelf);
    const g = globalThis as { __ktx2Booted?: number };
    g.__ktx2Booted = 0;
    const send = (data: unknown) => [...listeners].forEach((l) => l({ data }));
    send({ type: 'init' }); // not a boot message: ignored
    expect(g.__ktx2Booted).toBe(0);
    send({ type: 'boot', source: 'globalThis.__ktx2Booted += 1' });
    send({ type: 'boot', source: 'globalThis.__ktx2Booted += 1' });
    expect(g.__ktx2Booted).toBe(1);
    expect(listeners.size).toBe(0);
    delete g.__ktx2Booted;
  });
});
