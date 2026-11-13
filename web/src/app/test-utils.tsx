// Test helpers for the 2D pages: render the app at a path against the fake server, let async
// work settle, and query by data-test hooks.

import { render, type VNode } from 'preact';
import { act } from 'preact/test-utils';
import { vi } from 'vitest';
import { App } from './App';
import { resetDataCache } from './components/data';
import { createFakeServer, type FakeServer, type FakeServerOptions } from './fake/server';

const roots: HTMLElement[] = [];

export function useFakeServer(opts: FakeServerOptions = {}): FakeServer {
  const server = createFakeServer(opts);
  vi.stubGlobal('fetch', server.fetch);
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
