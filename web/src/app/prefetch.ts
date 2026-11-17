// Loads the room's code while a page sits idle, so the first tap finds it already there (the loading budget: Enter
// tap to the interviewer's first word in 4 s), and fetches a round's people (models, clips, texture transcoder) once
// the page knows the round. Fixture mode, tests and data saver connections skip it. A prefetch that fails changes
// nothing: the room loads whatever is missing itself.

import type { Catalog } from '../shared/types';
import { isFake } from './fake/mode';

let done = false;

function allowed(): boolean {
  if (typeof window === 'undefined' || import.meta.env.MODE === 'test' || isFake()) return false;
  return !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
}

function whenIdle(run: () => void): void {
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 3000 });
  else setTimeout(run, 1200);
}

export function prefetchRoom(): void {
  if (done || !allowed()) return;
  done = true;
  whenIdle(() => {
    const quiet = () => undefined;
    void import('../session/controller').catch(quiet);
    void import('../session/runtime').catch(quiet);
    void import('../xr/world').catch(quiet);
    void import('../xr/port').catch(quiet);
    void import('../board/boardXR').catch(quiet);
    void import('../xr/avatar').catch(quiet);
    void import('../xr/avatar/lipsync').catch(quiet);
    // Small parts the room otherwise asks for one after another after the tap.
    void import('virtual:iwsdk-project').catch(quiet);
    void import('../board/ops').catch(quiet);
    void import('../board/render').catch(quiet);
    void import('../board/mouse').catch(quiet);
  });
}

/** The avatar ids of a round's panel, from the catalog. */
export function roundAvatars(catalog: Catalog, roundId: string): string[] {
  const round = catalog.rounds.find((r) => r.id === roundId);
  if (!round) return [];
  const ids: string[] = [];
  for (const pid of [round.panel.lead, round.panel.second]) {
    if (!pid) continue;
    const p = catalog.personas.find((x) => x.id === pid || x.id === `persona.${pid}`);
    if (p) ids.push(p.avatar_id);
  }
  return ids;
}

const fetched = new Set<string>();

/**
 * Starts downloading a round's people. `now` skips the idle wait (the tap: the room needs them at once). Never
 * rejects.
 */
export function prefetchRound(catalog: Catalog | undefined, roundId: string, opts: { now?: boolean } = {}): void {
  if (!catalog || !allowed()) return;
  const ids = roundAvatars(catalog, roundId);
  const key = ids.join(',');
  // The tap always runs it (an idle prefetch may not have started); the downloads themselves are never doubled.
  if (!ids.length || (fetched.has(key) && !opts.now)) return;
  fetched.add(key);
  const run = () => void import('../xr/avatar/files').then((m) => m.prefetchAvatars(ids)).catch(() => fetched.delete(key));
  if (opts.now) run();
  else whenIdle(run);
}
