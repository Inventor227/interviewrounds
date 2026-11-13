// Device check calls: send results (POST /api/diag) and get an echo test voice (POST /api/diag/echo, dev key).
// The dev key is typed once on the page and kept for this tab only (sessionStorage).

import type { EchoVoice } from './echo';

const KEY = 'ir.devKey';

export const devKey = {
  get(): string {
    try {
      return sessionStorage.getItem(KEY) ?? '';
    } catch {
      return '';
    }
  },
  set(v: string): void {
    try {
      if (v) sessionStorage.setItem(KEY, v);
      else sessionStorage.removeItem(KEY);
    } catch {
      // private mode: the key lives only in the page
    }
  },
};

export class DiagError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new DiagError(0, 'network', e instanceof Error ? e.message : 'Network error');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const b = (data ?? {}) as { code?: string; message?: string };
    throw new DiagError(res.status, b.code ?? `http_${res.status}`, b.message ?? res.statusText);
  }
  return data as T;
}

/** Runs a call that needs an identity; makes a guest first (GET /api/me) when the browser has none. */
async function withIdentity<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof DiagError) || e.status !== 401) throw e;
    await call('GET', '/api/me');
    return run();
  }
}

export function sendResults(payload: object): Promise<{ id: number }> {
  return withIdentity(() => call<{ id: number }>('POST', '/api/diag', payload));
}

export function echoVoice(key: string): Promise<{ voice: EchoVoice; passage: string; max_seconds: number }> {
  return withIdentity(() => call('POST', '/api/diag/echo', {}, { 'x-dev-key': key }));
}
