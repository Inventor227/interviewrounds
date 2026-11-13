// Test helpers for the 2D pages: render the app at a path against the fake server, let async
// work settle, and query by data-test hooks.

import { render, type VNode } from 'preact';
import { act } from 'preact/test-utils';
import { vi, type Mock } from 'vitest';
import { App } from './App';
import { resetDataCache } from './components/data';
import { createFakeServer, type FakeServer, type FakeServerOptions } from './fake/server';
import { discardLaunch, registerRuntime, takeLaunch } from './launch';
import { api } from '../net/api';
import type { SocketPort } from '../session/ports';

const roots: HTMLElement[] = [];

/** The XR side of the round runtime the page tests register: spies, and a placement that never
 *  finishes, so enter() stops right after the XR request. */
export interface TestRuntime {
  log: string[];
  xrEnter: Mock<() => Promise<void>>;
  xrPreload: Mock<() => Promise<void>>;
  xrDispose: Mock<() => void>;
  /** The server closes the room socket for good (e.g. 4409 session ended). */
  closeSocket(code: number): void;
}
export let testRuntime: TestRuntime;

function installTestRuntime(): void {
  const log: string[] = [];
  const rt: TestRuntime = {
    log,
    xrEnter: vi.fn(async (): Promise<void> => void log.push('xr.enter')),
    xrPreload: vi.fn(async (): Promise<void> => void log.push('xr.preload')),
    xrDispose: vi.fn((): void => void log.push('xr.dispose')),
    closeSocket: (code) => terminal.forEach((cb) => cb({ code, reason: '' })),
  };
  testRuntime = rt;
  const terminal = new Set<(i: { code: number; reason: string }) => void>();
  const socket: SocketPort = {
    connect: async () => {},
    send: () => {},
    on: () => () => {},
    onTerminal: (cb) => (terminal.add(cb), () => terminal.delete(cb)),
    close: () => {},
  };
  registerRuntime(() => ({
    api,
    makeSocket: () => socket,
    makeTransport: () => {
      throw new Error('no voices in page tests');
    },
    xr: {
      preload: rt.xrPreload,
      enter: rt.xrEnter,
      dispose: rt.xrDispose,
      place: () => new Promise<void>(() => {}),
      ui: { setRoundState() {}, showSummary() {}, setStatus() {}, onAction: () => () => {} },
      room: { seatPoses: () => [] },
    },
    media: { getMic: async () => ({ getTracks: () => [] }) as unknown as MediaStream, resumeAudio: async () => {} },
  }));
}

export function useFakeServer(opts: FakeServerOptions = {}): FakeServer {
  const server = createFakeServer(opts);
  vi.stubGlobal('fetch', server.fetch);
  installTestRuntime();
  return server;
}

/** Lets pending promises, effects and re-renders run. */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
      else await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Settles until `cond` holds (or fails after `ms`). For work behind a lazy import. */
export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor: condition not met');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

export async function renderApp(path: string): Promise<HTMLElement> {
  resetDataCache();
  history.replaceState(null, '', path);
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  act(() => render(<App />, root));
  await settle();
  return root;
}

export async function renderNode(node: VNode): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  act(() => render(node, root));
  await settle(2);
  return root;
}

export function cleanup(): void {
  for (const r of roots.splice(0)) act(() => render(null, r));
  discardLaunch();
  void takeLaunch()?.controller.dispose();
  registerRuntime(null);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
}

export const $ = (root: ParentNode, test: string) => root.querySelector<HTMLElement>(`[data-test="${test}"]`);
export const $$ = (root: ParentNode, test: string) => [...root.querySelectorAll<HTMLElement>(`[data-test="${test}"]`)];

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('click: element not found');
  act(() => (el as HTMLElement).click());
  await settle();
}

export async function typeInto(el: Element | null, value: string): Promise<void> {
  if (!el) throw new Error('typeInto: element not found');
  const input = el as HTMLInputElement;
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(2);
}

/** Sets a property on navigator for one test (restore with the returned function). */
export function stubNavigator(key: string, value: unknown): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, key);
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(navigator, key, had);
    else delete (navigator as unknown as Record<string, unknown>)[key];
  };
}
