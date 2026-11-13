// Entry for the session page: picks passthrough (`ar`) when the browser can run immersive-ar, else the 2D preview,
// and creates the XR app. The world is created before the user taps, so the tap only calls enter() and keeps the
// browser's user activation (requestSession needs it).
//
// Dev query flags (ignored in production builds): view=preview forces the preview, seats=1|2|3, standins=1 seats
// converted avatars in passthrough too, offer=1 offers the session so emulator tooling can accept it,
// fallback=<s> waits longer for the desk touch (slow software rendering in the emulator).

import type { XRApp, XRMode } from './world';

export interface ImmersiveHandle {
  mode: XRMode;
  app: XRApp;
  /** Enters the room and places the desk; rejects with a message fit to show on the page. */
  enter(): Promise<void>;
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
    placementFallbackMs: dev && Number(q.get('fallback')) > 0 ? Number(q.get('fallback')) * 1000 : undefined,
  });
  if (dev) (globalThis as { __xrApp?: XRApp }).__xrApp = app;
  return {
    mode,
    app,
    enter: async () => {
      try {
        await app.enter();
      } catch (e) {
        console.warn('[xr] enter failed', e);
        throw new Error('The headset did not start the room. Tap Enter again.');
      }
      // Without the round controller (this page alone), place the desk right away.
      await app.place().catch(() => {});
    },
    exit: () => app.exit(),
    destroy: () => app.destroy(),
  };
}
