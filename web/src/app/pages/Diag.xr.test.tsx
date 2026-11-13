import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The headset test: the room is built only on Load, torn down when a run ends, and built fresh for the next run.
type Cb = (stage: string, line: string) => void;
const made: { cb: Cb; enter: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[] = [];

vi.mock('../../xr/entry', () => ({ pickMode: async () => 'ar' }));
vi.mock('../../diag/xrTest', () => ({
  createXrTest: vi.fn(async (_el: HTMLElement, cb: Cb) => {
    const t = {
      cb,
      enter: vi.fn(),
      destroy: vi.fn(),
      results: {
        error: null,
        tap_to_first_frame_ms: null,
        enabled_features: null,
        supported_frame_rates: null,
        start_frame_rate: null,
        placement: null,
        frames_72: null,
        frames_90: null,
        rate_90: { tried: false, ok: null, frame_rate_after: null, error: null },
        render: null,
        hands: null,
        selects: { starts: 0, ends: 0, cancels: 0 },
        finger_pinches: 0,
        select_per_pinch: null,
        tracked_pct: null,
        controllers_seen: false,
        visibility: [],
        ended_by: null,
      },
    };
    made.push(t);
    return t;
  }),
}));

const { Diag } = await import('./Diag');

let root: HTMLElement;
const q = (t: string) => root.querySelector(`[data-test="${t}"]`) as HTMLElement | null;
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

describe('Diag headset test lifecycle', () => {
  beforeEach(() => {
    made.length = 0;
    URL.createObjectURL = vi.fn(() => 'blob:tone');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
  });

  it('builds the room only on Load, frees it when the run ends, and builds a fresh one for the next run', async () => {
    await act(async () => render(<Diag />, root));
    await settle();
    expect(q('diag-xr-state')?.dataset.stage).toBe('unloaded');
    expect(made).toHaveLength(0);
    expect(q('diag-xr-run')).toBeNull();

    await act(async () => q('diag-xr-load')!.click());
    await settle();
    expect(made).toHaveLength(1);
    expect(q('diag-xr-state')?.dataset.stage).toBe('idle');
    await act(async () => q('diag-xr-run')!.click());
    expect(made[0]!.enter).toHaveBeenCalledOnce();

    await act(async () => made[0]!.cb('frames72', 'Frame test at 72 Hz.'));
    expect((q('diag-xr-run') as HTMLButtonElement).disabled).toBe(true);

    // The system ends the session (menu button): the numbers stay, the room goes.
    await act(async () => made[0]!.cb('ended', 'The headset view ended before the tests finished.'));
    await settle();
    expect(made[0]!.destroy).toHaveBeenCalledOnce();
    expect(q('diag-xr-state')?.textContent).toContain('Load the room to run it again.');
    expect(q('diag-xr-kv')).not.toBeNull();
    expect(q('diag-xr-run')).toBeNull();

    // A second run gets a fresh room.
    await act(async () => q('diag-xr-load')!.click());
    await settle();
    expect(made).toHaveLength(2);
    await act(async () => q('diag-xr-run')!.click());
    expect(made[1]!.enter).toHaveBeenCalledOnce();
    await act(async () => made[1]!.cb('done', 'All tests done.'));
    await settle();
    expect(made[1]!.destroy).toHaveBeenCalledOnce();
    expect(made[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('frees a loaded room when the page closes', async () => {
    await act(async () => render(<Diag />, root));
    await settle();
    await act(async () => q('diag-xr-load')!.click());
    await settle();
    render(null, root);
    expect(made[0]!.destroy).toHaveBeenCalledOnce();
  });
});
