import { describe, expect, it, vi } from 'vitest';
import { SelectRelay } from './select';

function fakeSession() {
  const t = new EventTarget();
  const fire = (type: 'selectstart' | 'selectend', handedness: XRHandedness) => {
    const e = new Event(type) as Event & { inputSource: { handedness: XRHandedness } };
    e.inputSource = { handedness };
    t.dispatchEvent(e);
  };
  return { session: t as unknown as XRSession, fire };
}

describe('SelectRelay', () => {
  it('relays_select_start_and_end_per_hand', () => {
    const relay = new SelectRelay(() => 1234);
    const cb = vi.fn();
    relay.on(cb);
    const { session, fire } = fakeSession();
    relay.attach(session);
    fire('selectstart', 'right');
    fire('selectend', 'right');
    fire('selectstart', 'none');
    expect(cb.mock.calls).toEqual([
      ['right', 'start', 1234],
      ['right', 'end', 1234],
    ]);
  });

  it('ends_held_selects_when_the_session_goes', () => {
    const relay = new SelectRelay(() => 5);
    const cb = vi.fn();
    relay.on(cb);
    const { session, fire } = fakeSession();
    relay.attach(session);
    fire('selectstart', 'left');
    relay.detach();
    expect(cb).toHaveBeenLastCalledWith('left', 'end', 5);
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
