import { describe, expect, it, vi } from 'vitest';
import { SelectRelay } from './select';

/** A session whose input sources keep their identity per hand, as in WebXR. */
function fakeSession() {
  const t = new EventTarget();
  const sources: Record<string, { handedness: XRHandedness }> = {};
  const src = (h: XRHandedness) => (sources[h] ??= { handedness: h });
  const fire = (type: 'selectstart' | 'select' | 'selectend', handedness: XRHandedness) => {
    const e = new Event(type) as Event & { inputSource: { handedness: XRHandedness } };
    e.inputSource = src(handedness);
    t.dispatchEvent(e);
  };
  /** A full pinch: start, the completed select, end. */
  const pinch = (h: XRHandedness) => {
    fire('selectstart', h);
    fire('select', h);
    fire('selectend', h);
  };
  return { session: t as unknown as XRSession, fire, pinch };
}

describe('SelectRelay', () => {
  it('relays_select_start_and_end_per_hand', () => {
    const relay = new SelectRelay(() => 1234);
    const cb = vi.fn();
    relay.on(cb);
    const { session, fire, pinch } = fakeSession();
    relay.attach(session);
    pinch('right');
    fire('selectstart', 'none');
    expect(cb.mock.calls).toEqual([
      ['right', 'start', 1234],
      ['right', 'end', 1234],
    ]);
  });

  it('a_selectend_without_select_is_a_cancel', () => {
    // The system cancelled the pinch (tracking lost, system gesture): WebXR ends it without `select`.
    const relay = new SelectRelay(() => 7);
    const cb = vi.fn();
    relay.on(cb);
    const { session, fire } = fakeSession();
    relay.attach(session);
    fire('selectstart', 'left');
    fire('selectend', 'left');
    expect(cb.mock.calls).toEqual([
      ['left', 'start', 7],
      ['left', 'cancel', 7],
    ]);
    // The next full pinch from the same source is a normal end again.
    fire('selectstart', 'left');
    fire('select', 'left');
    fire('selectend', 'left');
    expect(cb).toHaveBeenLastCalledWith('left', 'end', 7);
  });

  it('a_select_held_when_the_session_goes_is_cancelled', () => {
    const relay = new SelectRelay(() => 5);
    const cb = vi.fn();
    relay.on(cb);
    const { session, fire } = fakeSession();
    relay.attach(session);
    fire('selectstart', 'left');
    relay.detach();
    expect(cb).toHaveBeenLastCalledWith('left', 'cancel', 5);
    // Events from the old session no longer arrive.
    fire('selectstart', 'right');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe_stops_the_callback', () => {
    const relay = new SelectRelay(() => 0);
    const cb = vi.fn();
    const off = relay.on(cb);
    const { session, fire } = fakeSession();
    relay.attach(session);
    off();
    fire('selectstart', 'left');
    expect(cb).not.toHaveBeenCalled();
  });
});
