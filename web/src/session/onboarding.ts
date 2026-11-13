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
    this.timer = setTimeout(() => this.finish('skipped', 'timeout'), ONBOARD_TIMEOUT_MS);
  }

  /** The user left the headset view: the clock waits (a round never starts into an empty room). run() starts it again. */
  suspend(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
  /** The headset session ended. */
  onSessionEnd(cb: () => void): () => void;
  /** The page (document.visibilityState and its `visibilitychange`). */
  page?: { readonly visibilityState: string; addEventListener(t: 'visibilitychange', cb: () => void): void; removeEventListener(t: 'visibilitychange', cb: () => void): void };
}

/**
 * Keeps the onboarding's 20 s clock to the time the user is really in the room: it stops when the headset comes
 * off, the system menu opens, the page is hidden or the session ends, and starts fresh, with the line and Skip
 * shown again, when the room is visible again. (After a session end the way back is a new Enter, which calls
 * run() itself.) The round therefore never starts by itself while nobody is there.
 */
export function watchPresence(onboarding: Onboarding, src: PresenceSources): () => void {
  let xr: 'visible' | 'visible-blurred' | 'hidden' = 'visible';
  const sync = () => {
    const here = xr === 'visible' && src.page?.visibilityState !== 'hidden';
    if (!here) onboarding.suspend();
    else if (onboarding.showing) void onboarding.run();
  };
  const onPage = () => sync();
  src.page?.addEventListener('visibilitychange', onPage);
  const offs = [
    src.onXrVisibility((v) => {
      xr = v;
      sync();
    }),
    src.onSessionEnd(() => {
      // A new session starts visible; until then nothing counts.
      xr = 'visible';
      onboarding.suspend();
    }),
    () => src.page?.removeEventListener('visibilitychange', onPage),
  ];
  return () => offs.forEach((off) => off());
}
