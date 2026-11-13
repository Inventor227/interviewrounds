// `?fake=<scenario>` (dev builds only) serves fixture data from content/ instead of the server,
// so every page and state renders before the server routes exist. The choice sticks for the
// tab (sessionStorage) until `?fake=0`. Scenarios: see server.ts.

const KEY = 'ir_fake';

export function fakeScenario(search: string = globalThis.location?.search ?? ''): string | null {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return null;
  try {
    const q = new URLSearchParams(search).get('fake');
    if (q === '0') {
      sessionStorage.removeItem(KEY);
      return null;
    }
    if (q) {
      sessionStorage.setItem(KEY, q);
      return q;
    }
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Resolves once the fake fetch is in place (at once when fake mode is off). */
export const fakeReady: Promise<void> = (() => {
  const scenario = fakeScenario();
  if (!scenario) return Promise.resolve();
  return import('./server').then((m) => m.installFake(scenario)).catch(() => undefined);
})();

export const isFake = (): boolean => fakeScenario() !== null;
