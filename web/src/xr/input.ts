// Which input the user has in the room, and what a controller adds to a hand.
//
// Hands are the first-class path and what the room teaches; controllers do everything hands do. The session lists
// either hands or controllers per side, and the user can change at any time (put the controllers down, pick them
// up): the room follows `inputsourceschange` and each frame's sources, with no prompt and no restart.
//
// Pure logic here (testable without WebXR): the active input, button presses, haptic pulses and reading one
// controller from its gamepad. The world (world.ts) feeds it from the XR frame.

import type { HapticName } from '../board/pointer';
import type { Vec3 } from './math';

export type ActiveInput = 'hands' | 'controllers';
export type Side = 'left' | 'right';

/** One held controller, updated in place every XR frame (read it; do not keep or mutate). */
export interface ControllerState {
  hand: Side;
  tracked: boolean;
  /** The controller's front tip: the origin of its aim ray, about 5 cm ahead of the grip along the ray. */
  tip: Vec3;
  /** The aim ray's direction (unit). */
  dir: Vec3;
  /** The trigger is held. */
  pressed: boolean;
  /** The aim ray is on a panel (a button, a card) in front of whatever lies behind. */
  busy: boolean;
  /** Thumbstick, -1..1 per axis; y is negative when pushed away (up). */
  stick: { x: number; y: number };
  /** A finger rests on the trigger, or it is pulled. */
  touched: boolean;
}

export function newController(hand: Side): ControllerState {
  return { hand, tracked: false, tip: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: -1 }, pressed: false, busy: false, stick: { x: 0, y: 0 }, touched: false };
}

/**
 * The active input: `controllers` while the session lists a controller and no tracked hand, `hands` while it lists
 * a hand and no controller. With both (one of each) or neither (a moment between the two) the last one stays.
 * Starts as `hands`.
 */
export class InputTracker {
  private active: ActiveInput = 'hands';
  private readonly cbs = new Set<(a: ActiveInput) => void>();

  activeInput(): ActiveInput {
    return this.active;
  }

  onInputChange(cb: (a: ActiveInput) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  /** Feed with what the session has now (each frame, and on `inputsourceschange`). */
  update(seen: { hands: number; controllers: number }): ActiveInput {
    const next: ActiveInput = seen.controllers > 0 && seen.hands === 0 ? 'controllers' : seen.hands > 0 && seen.controllers === 0 ? 'hands' : this.active;
    if (next !== this.active) {
      this.active = next;
      for (const cb of [...this.cbs]) cb(next);
    }
    return this.active;
  }

  /** A new session starts with hands until a controller shows up. */
  reset(): void {
    this.update({ hands: 1, controllers: 0 });
  }
}

/** xr-standard gamepad layout (Meta Quest Touch): trigger, squeeze, -, thumbstick, A or X, B or Y; stick on axes 2 and 3. */
export const GAMEPAD = { trigger: 0, primary: 4, secondary: 5, stickX: 2, stickY: 3 } as const;

export type ControllerButton = 'primary' | 'secondary';

/** Reads what the room uses from a controller's gamepad. A missing gamepad reads as nothing pressed. */
export function readGamepad(g: { buttons: readonly { pressed: boolean; touched?: boolean; value?: number }[]; axes: readonly number[] } | null | undefined): {
  trigger: boolean;
  touched: boolean;
  primary: boolean;
  secondary: boolean;
  stick: { x: number; y: number };
} {
  const b = (i: number) => !!g?.buttons[i]?.pressed;
  const t = g?.buttons[GAMEPAD.trigger];
  return { trigger: b(GAMEPAD.trigger), touched: !!t && (t.pressed || !!t.touched || (t.value ?? 0) > 0), primary: b(GAMEPAD.primary), secondary: b(GAMEPAD.secondary), stick: { x: g?.axes[GAMEPAD.stickX] ?? 0, y: g?.axes[GAMEPAD.stickY] ?? 0 } };
}

/** Button presses (the moment a button goes down), per side. A button held when the controller appears does not count. */
export class ButtonEdges {
  private readonly held: Record<Side, Record<ControllerButton, boolean> | null> = { left: null, right: null };
  private readonly cbs = new Set<(hand: Side, button: ControllerButton, nowMs: number) => void>();

  on(cb: (hand: Side, button: ControllerButton, nowMs: number) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  /** Feed each frame per side; `null` when that side has no controller. */
  update(hand: Side, now: { primary: boolean; secondary: boolean } | null, nowMs: number): void {
    const was = this.held[hand];
    if (!now) {
      this.held[hand] = null;
      return;
    }
    this.held[hand] = { primary: now.primary, secondary: now.secondary };
    if (!was) return;
    for (const k of ['primary', 'secondary'] as const) if (now[k] && !was[k]) for (const cb of [...this.cbs]) cb(hand, k, nowMs);
  }

  reset(): void {
    this.held.left = this.held.right = null;
  }
}

/** Pulses: short and light (strength 0..1, milliseconds). A press is the lightest, the bin the longest. */
export const HAPTICS: Record<HapticName, { strength: number; ms: number }> = {
  press: { strength: 0.25, ms: 12 },
  snap: { strength: 0.45, ms: 18 },
  connect: { strength: 0.4, ms: 14 },
  bin: { strength: 0.5, ms: 28 },
};

/** A press on a panel pulses the controller whose trigger went down or up within this long (ms). */
export const PRESS_FRESH_MS = 250;

/** The parts of a Gamepad that can pulse (Quest Browser: hapticActuators[0].pulse; newer browsers: vibrationActuator). */
export interface HapticPad {
  hapticActuators?: readonly { pulse?(value: number, duration: number): unknown }[];
  vibrationActuator?: { playEffect?(type: string, params: { duration: number; strongMagnitude: number; weakMagnitude: number }): unknown } | null;
}

/** One pulse on a gamepad; false when it has nothing to pulse with. Never throws. */
export function pulsePad(pad: HapticPad | null | undefined, strength: number, ms: number): boolean {
  if (!pad) return false;
  try {
    const a = pad.hapticActuators?.[0];
    if (a?.pulse) {
      void Promise.resolve(a.pulse(strength, ms)).catch(() => undefined);
      return true;
    }
    const v = pad.vibrationActuator;
    if (v?.playEffect) {
      void Promise.resolve(v.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength })).catch(() => undefined);
      return true;
    }
  } catch {
    // A controller that went to sleep between the frame and the pulse.
  }
  return false;
}

/**
 * Haptics for the controllers in the room. While the user is speaking, a controller that rests on the desk does
 * not pulse: the desk can carry the buzz to the microphone, the same reason the room's sounds wait. A controller
 * held in the air (pointing by ray, pressing a panel) pulses as usual: 12 to 28 ms in the hand is not heard.
 */
export class Haptics {
  private readonly triggerAt: Record<Side, number> = { left: -Infinity, right: -Infinity };
  private readonly triggerHeld: Record<Side, boolean> = { left: false, right: false };
  /** Every pulse given, newest last (tooling and tests). */
  readonly log: { hand: Side; name: HapticName; atMs: number }[] = [];

  constructor(
    private readonly pad: (hand: Side) => HapticPad | null,
    private readonly isSpeaking: () => boolean = () => false,
    private readonly now: () => number = () => performance.now(),
    /** True when that side's controller rests on (or within a few centimetres of) the desk. Default: assume it does. */
    private readonly onDesk: (hand: Side) => boolean = () => true,
  ) {}

  /** A pulse on that side's controller. False when there is no controller there, or it rests on the desk while the user speaks. */
  pulse(hand: Side, name: HapticName): boolean {
    if (this.isSpeaking() && this.onDesk(hand)) return false;
    const h = HAPTICS[name];
    if (!pulsePad(this.pad(hand), h.strength, h.ms)) return false;
    this.log.push({ hand, name, atMs: Math.round(this.now()) });
    if (this.log.length > 50) this.log.shift();
    return true;
  }

  /** Feed each frame per side with the trigger's state (false when there is no controller). */
  trigger(hand: Side, held: boolean, nowMs: number): void {
    if (held !== this.triggerHeld[hand]) {
      this.triggerHeld[hand] = held;
      this.triggerAt[hand] = nowMs;
    }
  }

  /** A button on a panel was pressed: the controller that just pulled or let go of its trigger feels it. */
  press(nowMs: number): void {
    for (const hand of ['left', 'right'] as const) {
      if (this.triggerHeld[hand] || nowMs - this.triggerAt[hand] <= PRESS_FRESH_MS) this.pulse(hand, 'press');
    }
  }

  reset(): void {
    for (const hand of ['left', 'right'] as const) {
      this.triggerHeld[hand] = false;
      this.triggerAt[hand] = -Infinity;
    }
  }
}
