// XR select events per hand: a pinch on tracked hands, the trigger on controllers (the system maps both to
// selectstart / selectend on the session). The board uses them to draw and drag on the sheet. A select still held
// when the session ends gets its 'end', so nothing stays grabbed.

export type SelectHand = 'left' | 'right';
export type SelectPhase = 'start' | 'end';
export type SelectCallback = (hand: SelectHand, phase: SelectPhase, nowMs: number) => void;

export class SelectRelay {
  private readonly cbs = new Set<SelectCallback>();
  private readonly held = new Set<SelectHand>();
  private session: XRSession | null = null;
  private readonly onStart = (e: Event) => this.relay(e, 'start');
  private readonly onEnd = (e: Event) => this.relay(e, 'end');

  constructor(private readonly now: () => number = () => performance.now()) {}

  on(cb: SelectCallback): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  attach(session: XRSession): void {
    this.detach();
    this.session = session;
    session.addEventListener('selectstart', this.onStart);
    session.addEventListener('selectend', this.onEnd);
  }

  detach(): void {
    const s = this.session;
    this.session = null;
    if (s) {
      s.removeEventListener('selectstart', this.onStart);
      s.removeEventListener('selectend', this.onEnd);
    }
    const t = this.now();
    for (const h of [...this.held]) this.emit(h, 'end', t);
    this.held.clear();
  }

  private relay(e: Event, phase: SelectPhase): void {
    const h = (e as XRInputSourceEvent).inputSource?.handedness;
    if (h !== 'left' && h !== 'right') return;
    if (phase === 'start') this.held.add(h);
    else if (!this.held.delete(h)) return;
    this.emit(h, phase, this.now());
  }

  private emit(h: SelectHand, phase: SelectPhase, t: number): void {
    for (const cb of this.cbs) cb(h, phase, t);
  }
}
