import { describe, expect, it, vi } from 'vitest';
import { SelectRelay } from './select';

/** A session whose input sources keep their identity per hand, as in WebXR: tracked hands, or controllers. */
function fakeSession(kind: 'hand' | 'controller' = 'hand') {
  const t = new EventTarget();
  const sources: Record<string, { handedness: XRHandedness; hand?: object }> = {};
  const src = (h: XRHandedness, k: 'hand' | 'controller') => (sources[`${h}-${k}`] ??= k === 'hand' ? { handedness: h, hand: {} } : { handedness: h });
  const fire = (type: 'selectstart' | 'select' | 'selectend', handedness: XRHandedness, k: 'hand' | 'controller' = kind) => {
    const e = new Event(type) as Event & { inputSource: { handedness: XRHandedness } };
    e.inputSource = src(handedness, k);
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
      ['right', 'start', 1234, 'hand'],
      ['right', 'end', 1234, 'hand'],
    ]);
  });

  it('a_controller_trigger_is_relayed_the_same_way_and_says_it_is_a_controller', () => {
    const relay = new SelectRelay(() => 9);
    const cb = vi.fn();
    relay.on(cb);
    const { session, pinch, fire } = fakeSession('controller');
    relay.attach(session);
    pinch('left');
    expect(cb.mock.calls).toEqual([
      ['left', 'start', 9, 'controller'],
      ['left', 'end', 9, 'controller'],
    ]);
    // Hands take over on the same side: their pinch is a hand's select.
    fire('selectstart', 'left', 'hand');
    expect(cb).toHaveBeenLastCalledWith('left', 'start', 9, 'hand');
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
      ['left', 'start', 7, 'hand'],
      ['left', 'cancel', 7, 'hand'],
    ]);
    // The next full pinch from the same source is a normal end again.
    fire('selectstart', 'left');
    fire('select', 'left');
    fire('selectend', 'left');
    expect(cb).toHaveBeenLastCalledWith('left', 'end', 7, 'hand');
  });

  it('a_select_held_when_the_session_goes_is_cancelled', () => {
    const relay = new SelectRelay(() => 5);
    const cb = vi.fn();
    relay.on(cb);
    const { session, fire } = fakeSession();
    relay.attach(session);
    fire('selectstart', 'left');
    relay.detach();
    expect(cb).toHaveBeenLastCalledWith('left', 'cancel', 5, 'hand');
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
