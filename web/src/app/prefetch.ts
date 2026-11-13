// Loads the room's code while the home page sits idle, so the first tap finds it already there
// (the loading budget: Enter tap to the interviewer's first word in 4 s). Fixture mode, tests and
// data saver connections skip it.

import { isFake } from './fake/mode';

let done = false;

export function prefetchRoom(): void {
  if (done || typeof window === 'undefined' || import.meta.env.MODE === 'test' || isFake()) return;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  done = true;
  const run = () => {
    const quiet = () => undefined;
    void import('../session/controller').catch(quiet);
    void import('../session/runtime').catch(quiet);
    void import('../xr/world').catch(quiet);
    void import('../xr/port').catch(quiet);
    void import('../board/boardXR').catch(quiet);
    // The avatar code and the list of avatars; the models themselves load in the mic tap.
    void import('../xr/avatar').then((m) => m.loadManifest()).catch(quiet);
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 3000 });
  else setTimeout(run, 1200);
}
