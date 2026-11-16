// KTX2Loader whose Basis workers start from a same-origin script instead of a blob URL.
//
// The Basis transcoder's bindings build functions from strings (`new Function`) when they start. A blob worker
// inherits the page's Content-Security-Policy, which has no 'unsafe-eval', so on the real server (the Vite dev server
// sends no CSP) every transcoder worker died, no avatar texture decoded and avatars never loaded. A worker loaded
// from a URL runs under that response's own CSP instead (Chromium, Firefox and WebKit all do this): the server gives
// /vendor/basis/ktx2_worker.js a policy that allows eval inside that worker only. The page sends the worker the same
// source three would have put in the blob (its own worker code plus the transcoder), so nothing of three is copied.

import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { fetchBytes, takeBytes } from '../../net/bytes';

export const KTX2_WORKER_URL = '/vendor/basis/ktx2_worker.js';

type Statics = {
  BasisWorker: () => void;
  EngineFormat: unknown;
  EngineType: unknown;
  TranscoderFormat: unknown;
  BasisFormat: unknown;
};

/** The worker source three's KTX2Loader builds for its blob (r185): constants, the transcoder, its worker code. */
export function ktx2WorkerSource(transcoderJs: string): string {
  const k = KTX2Loader as unknown as Statics;
  const fn = k.BasisWorker.toString();
  return [
    '/* constants */',
    'let _EngineFormat = ' + JSON.stringify(k.EngineFormat),
    'let _EngineType = ' + JSON.stringify(k.EngineType),
    'let _TranscoderFormat = ' + JSON.stringify(k.TranscoderFormat),
    'let _BasisFormat = ' + JSON.stringify(k.BasisFormat),
    '/* basis_transcoder.js */',
    transcoderJs,
    '/* worker */',
    fn.substring(fn.indexOf('{') + 1, fn.lastIndexOf('}')),
  ].join('\n');
}

export interface Ktx2Urls {
  /** basis_transcoder.js and .wasm (full paths; may carry a version query). */
  js: string;
  wasm: string;
  worker: string;
}

export class OwnWorkerKTX2Loader extends KTX2Loader {
  private readonly urls: Ktx2Urls;

  constructor(urls: Ktx2Urls) {
    super();
    this.urls = urls;
  }

  override init(): Promise<void> {
    if (!this.transcoderPending) {
      // Through the shared byte cache, so a page that fetched them ahead hands them over here.
      const get = (url: string) => {
        void fetchBytes(url).catch(() => undefined);
        return takeBytes(url)!;
      };
      const pending = Promise.all([get(this.urls.js), get(this.urls.wasm)]).then(([js, binary]) => {
        const source = ktx2WorkerSource(new TextDecoder().decode(js));
        this.transcoderBinary = binary;
        this.workerPool.setWorkerCreator(() => {
          const worker = new Worker(this.urls.worker);
          // The first message is the code to run; three's own 'init' follows, as with its blob worker.
          worker.postMessage({ type: 'boot', source });
          const b = (this.transcoderBinary as ArrayBuffer).slice(0);
          worker.postMessage({ type: 'init', config: this.workerConfig, transcoderBinary: b }, [b]);
          return worker;
        });
      });
      // A failed download may be tried again by the next texture.
      pending.catch(() => {
        if (this.transcoderPending === pending) this.transcoderPending = null;
      });
      this.transcoderPending = pending;
    }
    return this.transcoderPending;
  }
}
