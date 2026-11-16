// What "getting the room ready" is doing right now, for the Start page's progress bar. launch.ts starts it, the room
// runtime moves it on (room, then people), and the byte cache gives the people step a real percentage when the
// sizes are known. Small on purpose: the 2D pages import it.

import { bytesProgress, onBytes } from '../net/bytes';

export type ReadyStep = 'setup' | 'room' | 'people';

export interface ReadyProgressState {
  step: ReadyStep;
  /** Who is coming in (the people step). */
  names: string[];
  /** The files the people step waits for (versioned URLs). */
  files: string[];
}

export interface ReadyView {
  step: ReadyStep | 'almost';
  /** One short line naming the step. */
  label: string;
  /** 0..1, or null when it cannot be known (an indeterminate bar). */
  fraction: number | null;
}

let state: ReadyProgressState | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const l of [...listeners]) l();
}

/** Starts a new prepare. */
export function startReady(): void {
  state = { step: 'setup', names: [], files: [] };
  changed();
}

export function readyStep(step: Exclude<ReadyStep, 'people'>): void {
  if (!state) return;
  state = { ...state, step };
  changed();
}

export function readyPeople(names: string[], files: string[]): void {
  if (!state) return;
  state = { step: 'people', names, files };
  changed();
}

export function clearReady(): void {
  state = null;
  changed();
}

export function readyState(): ReadyProgressState | null {
  return state;
}

/** Calls back when the step changes or the people's downloads move. */
export function onReady(cb: () => void): () => void {
  listeners.add(cb);
  const off = onBytes(cb);
  return () => {
    listeners.delete(cb);
    off();
  };
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Where each step sits on the bar. Most of the wait is the people's downloads, so they get most of it.
const SETUP = 0.06;
const ROOM = 0.16;
const PEOPLE_FROM = 0.24;
const PEOPLE_TO = 0.94;

/** The line and the bar for a state (null before any prepare). */
export function readyView(s: ReadyProgressState | null = state): ReadyView {
  if (!s || s.step === 'setup') return { step: 'setup', label: 'Setting up your round', fraction: s ? SETUP : null };
  if (s.step === 'room') return { step: 'room', label: 'Building the room', fraction: ROOM };
  const { loaded, total } = bytesProgress(s.files);
  if (s.files.length && total != null && total > 0 && loaded >= total) return { step: 'almost', label: 'Almost ready', fraction: PEOPLE_TO };
  const who = joinNames(s.names);
  const label = who ? `Bringing in ${who}` : 'Bringing in your panel';
  if (!s.files.length || total == null || total <= 0) return { step: 'people', label, fraction: null };
  return { step: 'people', label, fraction: PEOPLE_FROM + (PEOPLE_TO - PEOPLE_FROM) * Math.min(1, loaded / total) };
}
