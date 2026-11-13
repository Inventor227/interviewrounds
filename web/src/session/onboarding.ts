// Onboarding by doing, once per device, in the first round with a sheet: after the desk is placed
// a ghost hand shows "pinch and draw a box" over the sheet, and the step is done when the user has
// made one box themselves, pinched Skip, or 20 s have passed without a box. The round starts at
// that moment: the interviewer waits until then, and never longer than those 20 s. Nothing on
// screen counts down. Pure logic: the room supplies the board and the visuals.

export type OnboardResult = 'done' | 'skipped' | 'none';

/** The round starts by itself after this long without a box: the onboarding never holds a round. */
export const ONBOARD_TIMEOUT_MS = 20_000;

/** Kits where a drawn box becomes a card of the round (the coding and meeting sheets work differently). */
export const ONBOARDING_KITS: readonly string[] = ['hld', 'lld', 'pm'];

export interface OnboardingHost {
  /** The cards on the sheet now (ink strokes do not count). */
  cards(): { id: string }[];
  /** The board changed. */
  onBoard(cb: () => void): () => void;
  /** Shows the step's visuals (again, after the user left and came back); false takes them down. */
  show(on: boolean, why?: 'done' | 'skipped' | 'timeout'): void;
  /** The user pinched Skip. */
  onSkip(cb: () => void): () => void;
}

/** Whether this round teaches the gesture: a sheet where boxes are cards, on a device that has not done it. */
export function needsOnboarding(opts: { kit: string | null; done: boolean | undefined; preview: boolean }): boolean {
  return !opts.preview && opts.done === false && !!opts.kit && ONBOARDING_KITS.includes(opts.kit);
}

export class Onboarding {
  private readonly offs: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private on = false;
  private present = true;
  private result: Promise<OnboardResult> | null = null;
  private settle: ((r: OnboardResult) => void) | null = null;

  constructor(private readonly host: OnboardingHost) {}

  /** True while the step is on screen. */
  get showing(): boolean {
    return this.on;
  }

  /**
   * Starts the step and resolves when the user has made a box (`done`), skipped, or the time ran
   * out (`skipped`). A second call (the user left the headset view and came back) shows the
   * visuals again and returns the same promise.
   */
  run(): Promise<OnboardResult> {
    if (this.result) {
      if (this.on) {
        this.host.show(true);
        this.arm();
      }
      return this.result;
    }
    this.result = new Promise<OnboardResult>((resolve) => {
      this.settle = resolve;
      const before = new Set(this.host.cards().map((c) => c.id));
      this.on = true;
      this.host.show(true);
      this.offs.push(
        this.host.onBoard(() => {
          if (this.host.cards().some((c) => !before.has(c.id))) this.finish('done', 'done');
        }),
        this.host.onSkip(() => this.finish('skipped', 'skipped')),
      );
      this.arm();
    });
    return this.result;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.present) return; // nobody is in the room: the clock starts when they are
    this.timer = setTimeout(() => this.finish('skipped', 'timeout'), ONBOARD_TIMEOUT_MS);
  }

  /**
   * Whether the user is in the room (headset on, no system menu, page visible). Away: the clock waits, so a round
   * never starts into an empty room. Back: the line and Skip again, and a fresh 20 s.
   */
  setPresent(present: boolean): void {
    this.present = present;
    if (!present) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else if (this.on) {
      this.host.show(true);
      this.arm();
    }
  }

  private finish(result: OnboardResult, why?: 'done' | 'skipped' | 'timeout'): void {
    if (!this.on) return;
    this.on = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
    this.host.show(false, why);
    this.settle?.(result);
  }

  /** Takes everything down (the room is closed, or the round ended first); a waiting run() gets `none`. */
  dispose(): void {
    this.finish('none');
  }
}

/** Where the room learns whether the user is in it. */
export interface PresenceSources {
  /** XRSession visibility changes (`hidden`: headset off; `visible-blurred`: system menu). */
  onXrVisibility(cb: (v: 'visible' | 'visible-blurred' | 'hidden') => void): () => void;
  /** The session's visibility right now (a menu can already be up when the watch starts, or at a new Enter). */
  xrNow?(): 'visible' | 'visible-blurred' | 'hidden';
  /** The headset session ended. */
  onSessionEnd(cb: () => void): () => void;
  /** The page (document.visibilityState and its `visibilitychange`). */
  page?: { readonly visibilityState: string; addEventListener(t: 'visibilitychange', cb: () => void): void; removeEventListener(t: 'visibilitychange', cb: () => void): void };
}

export interface PresenceWatch {
  /** The user entered the headset view again (a new session): presence counts from its state now. */
  entered(): void;
  dispose(): void;
}

/**
 * Keeps the onboarding's 20 s clock to the time the user is really in the room. Present means: a headset session
 * that is `visible`, and a page that is not hidden. The state that already holds when the watch starts counts (a
 * system menu up as placement ends: no clock yet). After a session end nobody is present until the next Enter,
 * whatever the page's visibility does meanwhile. Coming back shows the line and Skip again and starts a fresh 20 s.
 */
export function watchPresence(onboarding: Onboarding, src: PresenceSources): PresenceWatch {
  let xr = src.xrNow?.() ?? 'visible';
  let ended = false;
  let present: boolean | null = null;
  const sync = () => {
    const here = !ended && xr === 'visible' && src.page?.visibilityState !== 'hidden';
    if (here === present) return;
    present = here;
    onboarding.setPresent(here);
  };
  const onPage = () => sync();
  src.page?.addEventListener('visibilitychange', onPage);
  const offs = [
    src.onXrVisibility((v) => {
      xr = v;
      sync();
    }),
    src.onSessionEnd(() => {
      ended = true;
      sync();
    }),
    () => src.page?.removeEventListener('visibilitychange', onPage),
  ];
  sync();
  return {
    entered() {
      ended = false;
      xr = src.xrNow?.() ?? 'visible';
      sync();
    },
    dispose: () => offs.forEach((off) => off()),
  };
}
