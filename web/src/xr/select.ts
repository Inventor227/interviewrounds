// XR select events per hand: a pinch on tracked hands, the trigger on controllers (the system maps both to
// selectstart / select / selectend on the session). The board uses them to draw and drag on the sheet.
// Phases match the board's port: 'end' for a completed select (a `select` event came first), 'cancel' for a
// selectend without `select` (the system cancelled it: tracking lost, a system gesture) and for a select still held
// when the session ends, so nothing is committed from a pinch the user did not finish.

export type SelectHand = 'left' | 'right';
export type SelectPhase = 'start' | 'end' | 'cancel';
/** What made the select: a tracked hand's pinch or a controller's trigger. */
export type SelectKind = 'hand' | 'controller';
export type SelectCallback = (hand: SelectHand, phase: SelectPhase, nowMs: number, kind: SelectKind) => void;

export class SelectRelay {
  private readonly cbs = new Set<SelectCallback>();
  private readonly held = new Map<SelectHand, SelectKind>();
  private session: XRSession | null = null;
  /** Input sources whose current select completed (a `select` event arrived). */
  private completed = new WeakSet<object>();
  private readonly onStart = (e: Event) => this.relay(e, 'start');
  private readonly onSelect = (e: Event) => {
    const src = (e as XRInputSourceEvent).inputSource;
    if (src) this.completed.add(src);
  };
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
    session.addEventListener('select', this.onSelect);
    session.addEventListener('selectend', this.onEnd);
  }

  detach(): void {
    const s = this.session;
    this.session = null;
    if (s) {
      s.removeEventListener('selectstart', this.onStart);
      s.removeEventListener('select', this.onSelect);
      s.removeEventListener('selectend', this.onEnd);
    }
    const t = this.now();
    for (const [h, kind] of [...this.held]) this.emit(h, 'cancel', t, kind);
    this.held.clear();
    this.completed = new WeakSet();
  }

  private relay(e: Event, kind: 'start' | 'end'): void {
    const src = (e as XRInputSourceEvent).inputSource;
    const h = src?.handedness;
    if (h !== 'left' && h !== 'right') return;
    const by: SelectKind = src.hand ? 'hand' : 'controller';
    if (kind === 'start') {
      this.completed.delete(src);
      this.held.set(h, by);
      this.emit(h, 'start', this.now(), by);
      return;
    }
    if (!this.held.delete(h)) return;
    const done = this.completed.has(src);
    this.completed.delete(src);
    this.emit(h, done ? 'end' : 'cancel', this.now(), by);
  }

  private emit(h: SelectHand, phase: SelectPhase, t: number, kind: SelectKind): void {
    for (const cb of this.cbs) cb(h, phase, t, kind);
  }
}
