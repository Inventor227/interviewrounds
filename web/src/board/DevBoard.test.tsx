import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevBoard } from './DevBoard';

describe('DevBoard', () => {
  beforeEach(() => {
    // jsdom has no 2D canvas; the page must still mount and work without drawing.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => {
    act(() => render(null, document.body));
    document.body.innerHTML = '';
  });

  function mount() {
    const root = document.createElement('div');
    document.body.append(root);
    act(() => render(<DevBoard />, root));
    return root;
  }

  it('shows the sandbox controls and exposes a handle for scripts', () => {
    const root = mount();
    expect(root.querySelector('[data-test="board-canvas"]')).not.toBeNull();
    expect(root.querySelector('[data-test="voice-input"]')).not.toBeNull();
    expect(root.querySelector('[data-test="undo"]')).not.toBeNull();
    expect(window.__board).toBeDefined();
  });

  it('labels the selected card from a voice line, and undo takes it back', () => {
    const root = mount();
    const b = window.__board!;
    act(() => {
      b.store.apply({ op_id: 't1', src: 'hand', op: 'item.create', args: { id: 'n1', kind: 'component', type: 'service', label: null, x: 10, y: 10, w: 8, h: 5 } });
    });
    expect(b.say('call that the order service')).toContain('Select a card');
    act(() => b.store.setFocus('n1'));
    act(() => {
      b.say('call that the order service');
    });
    expect(b.store.board.items[0]).toMatchObject({ label: 'Order service' });
    act(() => (root.querySelector('[data-test="undo"]') as HTMLButtonElement).click());
    expect(b.store.board.items[0]).toMatchObject({ label: null });
    expect(b.say('I think that is fine')).toContain('Not a label');
  });
});
