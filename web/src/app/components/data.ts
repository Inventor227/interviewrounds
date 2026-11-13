// Data loading for the 2D pages: a cached `me` and catalog, and a small async hook.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../../net/api';
import type { Catalog, LimitReason, Me, RoundPublic } from '../../shared/types';
import { LIMIT_REASONS } from '../../shared/types';
import { fakeReady } from '../fake/mode';

let mePromise: Promise<Me> | null = null;
let catalogPromise: Promise<Catalog> | null = null;

export function loadMe(fresh = false): Promise<Me> {
  if (fresh || !mePromise) {
    mePromise = fakeReady.then(() => api.me());
    mePromise.catch(() => (mePromise = null));
  }
  return mePromise;
}

/** Replace the cached `me` after a local change (settings saved, onboarding done). */
export function setMe(me: Me): void {
  mePromise = Promise.resolve(me);
}

export function loadCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    catalogPromise = fakeReady.then(() => api.catalog());
    catalogPromise.catch(() => (catalogPromise = null));
  }
  return catalogPromise;
}

/** Tests: forget cached data between renders. */
export function resetDataCache(): void {
  mePromise = null;
  catalogPromise = null;
}

export type Async<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'ready'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: ApiError };

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'unknown', err instanceof Error ? err.message : String(err));
}

/** Runs `fn` (after fake mode is ready) when `deps` change; `reload()` runs it again. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> & { reload: () => void } {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    setState((s) => (s.status === 'loading' ? s : { status: 'loading' }));
    fakeReady
      .then(() => fnRef.current())
      .then(
        (data) => live && setState({ status: 'ready', data }),
        (err) => live && setState({ status: 'error', error: toApiError(err) }),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// ---------- Caps ----------

export interface Cap {
  reason: LimitReason;
  resetsAt: string | null;
}

export function isLimitReason(code: unknown): code is LimitReason {
  return typeof code === 'string' && (LIMIT_REASONS as readonly string[]).includes(code);
}

/** A cap error from the server (any ApiError whose code is a LimitReason), else null. */
export function capFromError(err: unknown): Cap | null {
  if (!(err instanceof ApiError) || !isLimitReason(err.code)) return null;
  const at = err.body.resets_at;
  return { reason: err.code, resetsAt: typeof at === 'string' ? at : null };
}

export function capFromMe(me: Me | undefined, length: 'short' | 'full' = 'short'): Cap | null {
  if (!me) return null;
  const { limits } = me;
  if (limits.reason) {
    // A guest who used the full round can still take quick rounds.
    if (limits.reason === 'guest_full_used' && length === 'short') return null;
    return { reason: limits.reason, resetsAt: limits.resets_at };
  }
  if (length === 'full' && limits.full_left === 0) return { reason: 'guest_full_used', resetsAt: limits.resets_at };
  if (length === 'short' && limits.short_left_today === 0) return { reason: 'guest_daily_limit', resetsAt: limits.resets_at };
  return null;
}

// ---------- Catalog helpers ----------


export function findRound(catalog: Catalog, id: string): RoundPublic | undefined {
  return catalog.rounds.find((r) => r.id === id);
}

/** The other length of a round (`x.short` ⇄ `x.full`) when the catalog has it. */
export function otherLength(catalog: Catalog, round: RoundPublic): RoundPublic | undefined {
  const base = round.id.replace(/\.(short|full)$/, '');
  return catalog.rounds.find((r) => r.id === `${base}.${round.length === 'short' ? 'full' : 'short'}`);
}

export function persona(catalog: Catalog | undefined, id: string | null | undefined) {
  if (!catalog || !id) return undefined;
  return catalog.personas.find((p) => p.id === id || p.id === `persona.${id}`);
}
