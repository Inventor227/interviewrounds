// Starting a round from the 2D pages, in two taps, so nothing slow sits between the Enter tap
// and the XR session request (Quest Browser needs that tap's activation):
//
//   Phase A, the mic tap ("Start a quick round" on Home, or "Allow microphone" / "Get the room
//   ready" on Start, Meeting and Resume): the page gets the mic, then prepareLaunch() builds a
//   RoundController and runs controller.prepare(): audio unlock, the session (POST create, retry
//   or resume) and the room preload (code, world, renderer; no XR session yet).
//
//   Phase B, the Enter tap ("Enter the room"): enterLaunch() calls controller.enter()
//   synchronously, whose first await is the XR session request, then moves to /session/{id}.
//
// The session page calls takeLaunch() as it mounts and gets the running controller to show
// (state, errors, retry of a failed enter from a new tap). The controller and voice code are
// loaded on demand, so they never weigh on the 2D pages.
//
// The XR side is a runtime the session lane registers (registerRuntime) with the real room,
// avatars and board. Until then the default runtime uses the shell's placeholder world.

import { useEffect, useState } from 'preact/hooks';
import type { RoundController, RoundControllerDeps, PrepareInput } from '../session/controller';
import type { XRPort } from '../session/ports';
import type { CreateSessionRes } from '../shared/types';
import { getAudioContext } from '../voice/audio';
import { isFake } from './fake/mode';

export type { PrepareInput };

export interface RuntimeOptions {
  /** True when this device cannot enter immersive AR: run the 2D preview round. */
  preview: boolean;
}

/** Builds the controller's dependencies for one round. */
export type Runtime = (opts: RuntimeOptions) => RoundControllerDeps | Promise<RoundControllerDeps>;

let runtime: Runtime | null = null;

/** The session lane registers the real room here (XRPort with preload, avatars, board, head). */
export function registerRuntime(r: Runtime | null): void {
  runtime = r;
}

export interface Launch {
  key: string;
  input: PrepareInput;
  preview: boolean;
  title?: string;
  controller: RoundController;
}

export type LaunchState =
  | { status: 'idle' }
  | ({ status: 'preparing' } & Launch)
  | ({ status: 'ready'; session: CreateSessionRes } & Launch)
  | ({ status: 'failed'; error: unknown } & Launch);

let state: LaunchState = { status: 'idle' };
let prepareSeq = 0;
/** The launch handed to the session page by the Enter tap. */
let handed: (Launch & { session: CreateSessionRes }) | null = null;
const listeners = new Set<(s: LaunchState) => void>();

function set(next: LaunchState): void {
  state = next;
  for (const l of [...listeners]) l(next);
}

export function launchState(): LaunchState {
  return state;
}

/** Same input, same key: a page can tell whether the prepared round is still the one it shows. */
export function launchKey(input: PrepareInput, preview: boolean): string {
  return JSON.stringify([input, preview]);
}

/**
 * Phase A. Call from the mic tap once the page holds the mic stream (the controller owns it
 * from here and stops it on failure or dispose). Replaces any earlier prepared round.
 */
export async function prepareLaunch(input: PrepareInput, opts: { mic: MediaStream | null; preview: boolean; title?: string }): Promise<void> {
  // Inside the tap: unlock audio now, while the activation is fresh.
  void getAudioContext()?.resume().catch(() => undefined);
  discardLaunch();
  const seq = ++prepareSeq;
  const key = launchKey(input, opts.preview);
  const { RoundController } = await import('../session/controller');
  const deps = await (runtime ?? defaultRuntime)({ preview: opts.preview });
  if (seq !== prepareSeq) {
    // A newer tap started another round meanwhile.
    opts.mic?.getTracks().forEach((t) => t.stop());
    return;
  }
  const controller = new RoundController(deps);
  const base: Launch = { key, input, preview: opts.preview, title: opts.title, controller };
  set({ status: 'preparing', ...base });
  try {
    await controller.prepare(input, { mic: opts.mic });
    if (state.status !== 'preparing' || state.controller !== controller) return;
    set({ status: 'ready', session: controller.session!, ...base });
  } catch (error) {
    opts.mic?.getTracks().forEach((t) => t.stop());
    if (state.status === 'preparing' && state.controller === controller) set({ status: 'failed', error, ...base });
  }
}

/**
 * Phase B. Call from the Enter tap. Starts controller.enter() synchronously (its first await is
 * the XR request) and moves to the session page. Returns false when nothing is ready.
 */
export function enterLaunch(route: (url: string) => void): boolean {
  if (state.status !== 'ready') return false;
  const { status: _s, ...ready } = state;
  ready.controller.enter().catch(() => undefined); // errors reach the session page as controller events
  handed = ready;
  set({ status: 'idle' });
  route(`/session/${encodeURIComponent(ready.session.session_id)}`);
  return true;
}

/** The session page takes the entered round once, as it mounts. */
export function takeLaunch(): (Launch & { session: CreateSessionRes }) | null {
  const h = handed;
  handed = null;
  return h;
}

/** Drops a prepared round that was never entered (the page was left, or the inputs changed). */
export function discardLaunch(): void {
  if (state.status === 'idle') return;
  const c = state.controller;
  set({ status: 'idle' });
  void c.dispose();
}

/** The launch state, live. */
export function useLaunch(): LaunchState {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => void listeners.delete(setS);
  }, []);
  return s;
}

// ---------- Default runtime (until the session lane registers the real room) ----------

/** The shell's placeholder world: preloaded in phase A, entered in phase B. */
function placeholderXr(preview: boolean): XRPort {
  let handle: import('../xr/entry').ImmersiveHandle | null = null;
  return {
    async preload() {
      // Fixture mode (screenshots) and the 2D preview never load the 3D world.
      if (preview || isFake() || handle) return;
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.append(host);
      const { createImmersive } = await import('../xr/entry');
      handle = await createImmersive(host);
    },
    async enter() {
      if (preview || isFake()) return;
      if (!handle) throw new Error('The room is not loaded');
      handle.enter();
    },
    async place() {},
    exit: () => handle?.exit(),
    ui: { setRoundState() {}, showSummary() {}, setStatus() {}, onAction: () => () => {} },
    room: { seatPoses: () => [] },
  };
}

const defaultRuntime: Runtime = async ({ preview }) => {
  const [{ api }, browser] = await Promise.all([import('../net/api'), import('../session/browser')]);
  return {
    api,
    makeSocket: browser.makeSocket,
    makeTransport: browser.makeTransport(),
    xr: placeholderXr(preview),
    media: browser.browserMedia,
    visibility: browser.pageVisibility,
  };
};
