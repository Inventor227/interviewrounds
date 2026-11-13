// Mouse (and pen or touch) input for a 2D board canvas: the same PointerAdapter the
// hands use, so the whole board can be built and tested in a normal browser tab.
import type { BoardPoint, PointerAdapter } from './input';
import type { Pt } from './model';

type Cb = (p: BoardPoint) => void;

export class MouseAdapter implements PointerAdapter {
  private downs = new Set<Cb>();
  private moves = new Set<Cb>();
  private ups = new Set<Cb>();
  private pressed: number | null = null;
  private readonly offs: (() => void)[] = [];

  /** `toBoard` maps a point in the canvas's CSS pixels to board cm. */
  constructor(
    private readonly el: HTMLElement,
    private readonly toBoard: (x: number, y: number) => Pt,
  ) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => {
      if (e.button !== 0 || this.pressed !== null) return;
      this.pressed = e.pointerId;
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      this.fire(this.downs, e);
    });
    on('pointermove', (e) => {
      if (this.pressed !== null && e.pointerId !== this.pressed) return;
      // Coalesced events keep fast strokes smooth.
      const events = this.pressed !== null && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      if (events.length) for (const ce of events) this.fire(this.moves, ce);
      else this.fire(this.moves, e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pressed) return;
      this.pressed = null;
      el.releasePointerCapture?.(e.pointerId);
      this.fire(this.ups, e);
    };
    on('pointerup', end);
    on('pointercancel', end);
  }

  private fire(set: Set<Cb>, e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    const [x, y] = this.toBoard(e.clientX - r.left, e.clientY - r.top);
    const p: BoardPoint = { x_cm: x, y_cm: y, t_ms: e.timeStamp, hand: 'mouse' };
    for (const cb of [...set]) cb(p);
  }

  onDown(cb: Cb): () => void {
    this.downs.add(cb);
    return () => this.downs.delete(cb);
  }
  onMove(cb: Cb): () => void {
    this.moves.add(cb);
    return () => this.moves.delete(cb);
  }
  onUp(cb: Cb): () => void {
    this.ups.add(cb);
    return () => this.ups.delete(cb);
  }

  destroy(): void {
    this.offs.forEach((off) => off());
    this.downs.clear();
    this.moves.clear();
    this.ups.clear();
  }
}
