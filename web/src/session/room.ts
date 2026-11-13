// The live room of the current round, as the session page sees it: where the 3D canvas lives,
// whether this is the 2D preview, the board the mouse can draw on, and the start's stage timings.
// Kept free of 3D imports so the 2D pages can read it without loading the room code.

import type { StageTimings } from './timings';

export interface LiveRoom {
  /** The element the room's canvas is in; the session page moves it into its stage. */
  readonly host: HTMLElement;
  /** True in the 2D preview (no immersive session on this device). */
  readonly preview: boolean;
  readonly timings: StageTimings;
  /** True when this round has a sheet to draw on. Known once the room is loaded. */
  hasBoard: boolean;
  /**
   * Preview only: the flat view of the sheet that the mouse draws on. The session page hands over
   * its canvas once the room is loaded; returns a cleanup.
   */
  attachBoardCanvas?(canvas: HTMLCanvasElement): () => void;
  /** The headset session ended while the round was running (the user left it): offer the way back. */
  sessionLost: boolean;
  /** Development builds only: handles for emulator scripts (the board store, sheet points in the room). */
  debug?: Record<string, unknown>;
  /** The room loaded or changed what it offers (the board became available). */
  onChange(cb: () => void): () => void;
}

let current: LiveRoom | null = null;

export function liveRoom(): LiveRoom | null {
  return current;
}

export function setLiveRoom(room: LiveRoom): void {
  current = room;
}

/** Clears the registry if `room` is still the current one (a newer round may have replaced it). */
export function clearLiveRoom(room: LiveRoom): void {
  if (current === room) current = null;
}
