import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../voice/transport';
import type { ControllerEvents } from './controller';
import { DevConsole, type DevConsoleSource } from './DevConsole';
import type { LatencySplit } from './latency';
import { isDebug } from './browser';

function source() {
  const ev = new Emitter<ControllerEvents>();
  const history: LatencySplit[] = [];
  const s: DevConsoleSource & { ev: typeof ev; history: LatencySplit[] } = {
    ev,
    history,
    state: 'live',
    latencyHistory: history,
    on: (e, cb) => ev.on(e, cb),
    sendTypedTurn: vi.fn(),
  };
  return s;
}

function mount(s: DevConsoleSource): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  act(() => render(<DevConsole source={s} />, root));
  return root;
}

describe('DevConsole', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('enter_sends_a_typed_turn', () => {
    const s = source();
    const root = mount(s);
    const input = root.querySelector<HTMLInputElement>('[data-test="dev-input"]')!;
    act(() => {
      input.value = '  I would add a cache  ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(s.sendTypedTurn).toHaveBeenCalledWith('I would add a cache');
    expect(input.value).toBe('');
  });

  it('shows_state_transcript_and_latency', () => {
    const s = source();
    const root = mount(s);
    act(() => {
      s.ev.emit('state', 'paused');
      s.ev.emit('transcript', { panelistId: 'p1', role: 'user', text: 'Hi', final: false });
      s.ev.emit('transcript', { panelistId: 'p1', role: 'user', text: 'Hi there', final: true });
      s.history.push({ turn: 1, user_final_at_ms: 0, to_thinking_ms: null, to_first_text_ms: 1500 });
      s.ev.emit('latency', s.history[0]!);
    });
    expect(root.querySelector('[data-test="dev-state"]')!.textContent).toContain('paused');
    expect(root.querySelectorAll('li')).toHaveLength(1);
    expect(root.textContent).toContain('Hi there');
    expect(root.querySelector('[data-test="dev-latency"]')!.textContent).toContain('1500 ms');
  });
});

describe('isDebug', () => {
  it('reads_the_debug_flag', () => {
    expect(isDebug('?debug=1')).toBe(true);
    expect(isDebug('?debug=0')).toBe(false);
    expect(isDebug('')).toBe(false);
  });
});
