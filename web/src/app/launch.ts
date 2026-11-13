// Hand-off from the 2D pages to the live session page.
//
// The round must start inside the user's Start tap: Quest Browser needs that gesture to enter
// XR, and RoundController.start() asks for the mic, creates the session and enters XR in one
// chain (see session/controller.ts). So the Start button stores what to launch here and moves
// to the session page with a client side navigation (no reload, so the tap's activation is
// still live). The session page calls takeLaunch() as it mounts and starts the controller
// right away:
//
//   { kind: 'new' }    → controller.start(req)                       at /session/new
//   { kind: 'retry' }  → POST /api/sessions/{parent}/retry, then run  at /session/new
//   { kind: 'resume' } → POST /api/sessions/{id}/resume, then run     at /session/{id}
//
// `preview` is true when this browser cannot enter an immersive session: run the 2D preview
// round on the screen instead of entering XR. `mic` is the live stream from the Start page's mic
// step when there is one: hand it to the controller's first getMic() instead of asking again.

import type { CreateSessionReq } from '../shared/types';

interface LaunchBase {
  preview: boolean;
  mic?: MediaStream | null;
  title?: string;
}

export type Launch =
  | (LaunchBase & { kind: 'new'; req: CreateSessionReq })
  | (LaunchBase & { kind: 'retry'; parentSessionId: string })
  | (LaunchBase & { kind: 'resume'; sessionId: string });

/** A launch older than this no longer has the tap's activation and is ignored. */
export const LAUNCH_MAX_AGE_MS = 5000;

let pending: (Launch & { at: number }) | null = null;

export function sessionPath(l: Launch): string {
  return l.kind === 'resume' ? `/session/${encodeURIComponent(l.sessionId)}` : '/session/new';
}

/** Call from the click handler, then navigate client side to sessionPath(l). */
export function setLaunch(l: Launch): void {
  pending = { ...l, at: Date.now() };
}

/** The session page takes the pending launch once; null when there is none or it is stale. */
export function takeLaunch(now: number = Date.now()): Launch | null {
  const p = pending;
  pending = null;
  if (!p) return null;
  if (now - p.at > LAUNCH_MAX_AGE_MS) {
    p.mic?.getTracks().forEach((t) => t.stop());
    return null;
  }
  const { at: _at, ...launch } = p;
  return launch;
}

/** Tests: look without taking. */
export function peekLaunch(): Launch | null {
  return pending;
}

/** Stores the launch and moves to the session page. Call inside the tap. */
export function launchNow(l: Launch, route: (url: string) => void): void {
  setLaunch(l);
  route(sessionPath(l));
}
