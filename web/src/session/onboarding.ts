// Onboarding by doing, once per device, in the first round with a sheet: after the desk is placed
// a ghost hand shows "pinch and draw a box" over the sheet, and the step is done only when the
// user has made one box themselves (or pinched Skip). The round starts at that moment: the
// interviewer waits until then. A second line, "Say its name", stays up until the first label or
// for 8 s; by then the round is running and the mic is open, so saying the name really labels it.
// Pure logic: the room supplies the board and the visuals.

export type OnboardStep = 'box' | 'name';
export type OnboardResult = 'done' | 'skipped' | 'none';

/** How long "Say its name" stays up without a label. */
export const NAME_STEP_MS = 8000;

/** Kits where a drawn box becomes a card of the round (the coding and meeting sheets work differently). */
export const ONBOARDING_KITS: readonly string[] = ['hld', 'lld', 'pm'];

export interface OnboardingHost {
  /** The cards on the sheet now (ink strokes do not count). */
  cards(): { id: string; labelled: boolean }[];
  /** The board changed. */
  onBoard(cb: () => void): () => void;
  /** Shows a step's visuals; null takes them down. */
  show(step: OnboardStep | null): void;
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
  private step: OnboardStep | null = null;
  private result: Promise<OnboardResult> | null = null;

  constructor(private readonly host: OnboardingHost) {}

  /** The step on screen now. */
  get showing(): OnboardStep | null {
    return this.step;
  }

  /**
   * Starts the box step and resolves when the user has made a box (`done`) or skipped. The name
   * step then runs by itself. A second call returns the same promise.
   */
  run(): Promise<OnboardResult> {
    this.result ??= new Promise<OnboardResult>((resolve) => {
      const before = new Set(this.host.cards().map((c) => c.id));
      this.set('box');
      const offBoard = this.host.onBoard(() => {
        if (this.step !== 'box') return;
        const made = this.host.cards().find((c) => !before.has(c.id));
        if (!made) return;
        resolve('done');
        this.nameStep(made.labelled);
      });
      const offSkip = this.host.onSkip(() => {
        if (this.step === null) return;
        const wasBox = this.step === 'box';
        this.finish();
        if (wasBox) resolve('skipped');
      });
      this.offs.push(offBoard, offSkip);
    });
    return this.result;
  }

  private nameStep(alreadyNamed: boolean): void {
    if (alreadyNamed) return this.finish();
    const labels = () => this.host.cards().filter((c) => c.labelled).length;
    const had = labels();
    this.set('name');
    this.offs.push(
      this.host.onBoard(() => {
        if (this.step === 'name' && labels() > had) this.finish();
      }),
    );
    this.timer = setTimeout(() => this.finish(), NAME_STEP_MS);
  }

  private set(step: OnboardStep | null): void {
    this.step = step;
    this.host.show(step);
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
    if (this.step !== null) this.set(null);
  }

  /** Takes everything down (the room is closed, or the round ended before the box). */
  dispose(): void {
    this.finish();
  }
}
