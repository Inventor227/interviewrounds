import { describe, expect, it, vi } from 'vitest';
import { ButtonEdges, GAMEPAD, Haptics, HAPTICS, InputTracker, PRESS_FRESH_MS, pulsePad, readGamepad, type HapticPad } from './input';

describe('active input', () => {
  it('starts_with_hands_and_follows_what_the_session_lists', () => {
    const t = new InputTracker();
    const seen: string[] = [];
    t.onInputChange((a) => seen.push(a));
    expect(t.activeInput()).toBe('hands');
    t.update({ hands: 2, controllers: 0 });
    expect(seen).toEqual([]);
    // The user picks the controllers up: the hands leave the list, the controllers join it.
    t.update({ hands: 0, controllers: 2 });
    expect(t.activeInput()).toBe('controllers');
    // A moment with nothing listed (between the two) changes nothing.
    t.update({ hands: 0, controllers: 0 });
    expect(t.activeInput()).toBe('controllers');
    // Controllers down, hands back.
    t.update({ hands: 1, controllers: 0 });
    expect(t.activeInput()).toBe('hands');
    expect(seen).toEqual(['controllers', 'hands']);
  });

  it('one_hand_and_one_controller_keeps_what_was_active', () => {
    const t = new InputTracker();
    t.update({ hands: 1, controllers: 1 });
    expect(t.activeInput()).toBe('hands');
    t.update({ hands: 0, controllers: 1 });
    t.update({ hands: 1, controllers: 1 });
    expect(t.activeInput()).toBe('controllers');
  });

  it('a_new_session_starts_with_hands_and_unsubscribe_stops_the_event', () => {
    const t = new InputTracker();
    const cb = vi.fn();
    const off = t.onInputChange(cb);
    t.update({ hands: 0, controllers: 2 });
    t.reset();
    expect(t.activeInput()).toBe('hands');
    expect(cb.mock.calls.map((c) => c[0])).toEqual(['controllers', 'hands']);
    off();
    t.update({ hands: 0, controllers: 2 });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

/** An xr-standard gamepad as a Quest Touch controller reports it. */
function pad(o: { trigger?: boolean; a?: boolean; b?: boolean; stickY?: number } = {}) {
  const buttons = Array.from({ length: 7 }, () => ({ pressed: false }));
  buttons[GAMEPAD.trigger]!.pressed = !!o.trigger;
  buttons[GAMEPAD.primary]!.pressed = !!o.a;
  buttons[GAMEPAD.secondary]!.pressed = !!o.b;
  return { buttons, axes: [0, 0, 0, o.stickY ?? 0] };
}

describe('controller buttons', () => {
  it('reads_trigger_a_b_and_the_thumbstick_from_an_xr_standard_gamepad', () => {
    expect(readGamepad(pad({ trigger: true, a: true, stickY: -0.8 }))).toEqual({ trigger: true, touched: true, primary: true, secondary: false, stick: { x: 0, y: -0.8 } });
    expect(readGamepad(null)).toEqual({ trigger: false, touched: false, primary: false, secondary: false, stick: { x: 0, y: 0 } });
    // A finger resting on the trigger without pulling it.
    expect(readGamepad({ buttons: [{ pressed: false, touched: true, value: 0 }], axes: [] }).touched).toBe(true);
  });

  it('a_press_fires_once_when_the_button_goes_down', () => {
    const e = new ButtonEdges();
    const cb = vi.fn();
    e.on(cb);
    e.update('right', readGamepad(pad()), 0);
    e.update('right', readGamepad(pad({ a: true })), 14);
    e.update('right', readGamepad(pad({ a: true })), 28);
    e.update('right', readGamepad(pad()), 42);
    e.update('right', readGamepad(pad({ b: true })), 56);
    expect(cb.mock.calls).toEqual([
      ['right', 'primary', 14],
      ['right', 'secondary', 56],
    ]);
  });

  it('a_button_already_held_when_the_controller_appears_is_not_a_press', () => {
    const e = new ButtonEdges();
    const cb = vi.fn();
    e.on(cb);
    e.update('left', readGamepad(pad({ a: true })), 0);
    e.update('left', readGamepad(pad({ a: true })), 14);
    expect(cb).not.toHaveBeenCalled();
    // The controller goes away and comes back with X still down: still not a press.
    e.update('left', null, 28);
    e.update('left', readGamepad(pad({ a: true })), 42);
    expect(cb).not.toHaveBeenCalled();
    e.update('left', readGamepad(pad()), 56);
    e.update('left', readGamepad(pad({ a: true })), 70);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('haptics', () => {
  const quest = () => {
    const pulse = vi.fn(() => Promise.resolve(true));
    return { pulse, pad: { hapticActuators: [{ pulse }] } as HapticPad };
  };

  it('pulses_are_short_and_light', () => {
    for (const h of Object.values(HAPTICS)) {
      expect(h.strength).toBeLessThanOrEqual(0.5);
      expect(h.ms).toBeLessThanOrEqual(30);
    }
    expect(HAPTICS.press.strength).toBeLessThan(HAPTICS.snap.strength);
  });

  it('pulses_the_controller_of_that_side_through_hapticActuators', () => {
    const r = quest();
    const h = new Haptics((hand) => (hand === 'right' ? r.pad : null));
    expect(h.pulse('right', 'snap')).toBe(true);
    expect(r.pulse).toHaveBeenCalledWith(HAPTICS.snap.strength, HAPTICS.snap.ms);
    // A hand has nothing to pulse.
    expect(h.pulse('left', 'snap')).toBe(false);
    expect(h.log.map((l) => [l.hand, l.name])).toEqual([['right', 'snap']]);
  });

  it('falls_back_to_the_vibration_actuator_and_never_throws', () => {
    const playEffect = vi.fn(() => Promise.reject(new Error('asleep')));
    expect(pulsePad({ vibrationActuator: { playEffect } }, 0.4, 14)).toBe(true);
    expect(playEffect).toHaveBeenCalledWith('dual-rumble', { duration: 14, strongMagnitude: 0.4, weakMagnitude: 0.4 });
    expect(pulsePad({}, 0.4, 14)).toBe(false);
    expect(pulsePad(null, 0.4, 14)).toBe(false);
    expect(
      pulsePad(
        {
          hapticActuators: [
            {
              pulse: () => {
                throw new Error('gone');
              },
            },
          ],
        },
        0.4,
        14,
      ),
    ).toBe(false);
  });

  it('nothing_pulses_while_the_user_is_speaking', () => {
    const r = quest();
    let speaking = true;
    const h = new Haptics(() => r.pad, () => speaking);
    expect(h.pulse('right', 'bin')).toBe(false);
    expect(r.pulse).not.toHaveBeenCalled();
    speaking = false;
    expect(h.pulse('right', 'bin')).toBe(true);
  });

  it('a_panel_press_pulses_the_controller_that_pulled_its_trigger', () => {
    const left = quest();
    const right = quest();
    const h = new Haptics((hand) => (hand === 'left' ? left.pad : right.pad));
    h.trigger('right', true, 1000);
    h.press(1010);
    expect(right.pulse).toHaveBeenCalledWith(HAPTICS.press.strength, HAPTICS.press.ms);
    expect(left.pulse).not.toHaveBeenCalled();
    // A click arrives when the trigger lets go: still that controller, for a moment.
    h.trigger('right', false, 1200);
    h.press(1200 + PRESS_FRESH_MS);
    expect(right.pulse).toHaveBeenCalledTimes(2);
    // Later presses (a hand's poke, the system) pulse nobody.
    h.press(1200 + PRESS_FRESH_MS + 1);
    expect(right.pulse).toHaveBeenCalledTimes(2);
  });
});
