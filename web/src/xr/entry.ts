// Entry for the session page: picks passthrough (`ar`) when the browser can run immersive-ar, else the 2D preview,
// and creates the XR app. The world is created before the user taps, so the tap only calls enter() and keeps the
// browser's user activation (requestSession needs it).
//
// Dev query flags (ignored in production builds): view=preview forces the preview, seats=1|2|3, standins=1 seats
// converted avatars in passthrough too, offer=1 offers the session so emulator tooling can accept it.

import type { XRApp, XRMode } from './world';

export interface ImmersiveHandle {
  mode: XRMode;
  app: XRApp;
  enter(): void;
  exit(): void;
  destroy(): void;
}

export async function pickMode(search = globalThis.location?.search ?? ''): Promise<XRMode> {
  const q = new URLSearchParams(search);
  if (import.meta.env.DEV && q.get('view') === 'preview') return 'preview';
  const xr = (globalThis.navigator as Navigator | undefined)?.xr;
  if (!xr) return 'preview';
  try {
    return (await xr.isSessionSupported('immersive-ar')) ? 'ar' : 'preview';
  } catch {
    return 'preview';
  }
}

export async function createImmersive(container: HTMLElement, opts: { seats?: 1 | 2 | 3 } = {}): Promise<ImmersiveHandle> {
  const mode = await pickMode();
  // Loaded on demand so the 2D pages never pay for the 3D runtime.
  const [{ createXRApp }, project] = await Promise.all([import('./world'), import('virtual:iwsdk-project')]);
  const q = new URLSearchParams(location.search);
  const dev = import.meta.env.DEV;
  const seatsQ = Number(q.get('seats'));
  const seats = dev && (seatsQ === 1 || seatsQ === 2 || seatsQ === 3) ? seatsQ : (opts.seats ?? 1);
  const app = await createXRApp(container, {
    mode,
    base: project.default,
    seats,
    offer: dev && q.get('offer') === '1',
    // The preview always seats people; in passthrough the avatar runtime does (stand-ins on request in dev).
    standins: mode === 'preview' || (dev && q.get('standins') === '1'),
  });
  if (dev) (globalThis as { __xrApp?: XRApp }).__xrApp = app;
  return {
    mode,
    app,
    enter: () => {
      app.enter().catch((e: unknown) => console.warn('[xr] enter failed', e));
    },
    exit: () => app.exit(),
    destroy: () => app.destroy(),
  };
}
