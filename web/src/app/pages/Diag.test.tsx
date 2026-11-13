import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Diag } from './Diag';

let root: HTMLElement;
const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

const q = (t: string) => root.querySelector(`[data-test="${t}"]`) as HTMLElement | null;

describe('Diag page', () => {
  beforeEach(() => {
    calls.length = 0;
    sessionStorage.clear();
    history.replaceState(null, '', '/diag');
    URL.createObjectURL = vi.fn(() => 'blob:tone');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
  });

  function stubFetch(answers: Record<string, { status: number; body: unknown }[]>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        const method = init.method ?? 'GET';
        calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> });
        const a = answers[`${method} ${path}`]?.shift() ?? { status: 404, body: { code: 'not_found', message: 'no' } };
        return new Response(JSON.stringify(a.body), { status: a.status });
      }),
    );
  }

  it('shows all seven steps, reads the device and the blocked autoplay, and says when there is no passthrough', async () => {
    stubFetch({});
    await act(async () => render(<Diag />, root));
    await settle();
    for (const s of ['device', 'mic', 'autoplay', 'xr', 'hands', 'echo', 'results']) expect(q(`diag-${s}`)).not.toBeNull();
    expect(q('diag-device-kv')?.textContent).toContain('WebXR');
    expect(q('diag-autoplay-kv')?.textContent).toContain('blocked');
    // The support check loads on demand; wait for it.
    for (let i = 0; i < 100 && q('diag-xr-state')?.dataset.stage === 'checking'; i++) await act(async () => await new Promise((r) => setTimeout(r, 50)));
    expect(q('diag-xr-state')?.dataset.stage).toBe('none');
    expect((q('diag-xr-load') as HTMLButtonElement).disabled).toBe(true);
    expect(q('diag-xr-run')).toBeNull();
    // The paid echo test is for the team only: no key field or price without ?dev=1.
    expect(q('diag-key')).toBeNull();
    expect(q('diag-echo-run')).toBeNull();
    expect(q('diag-echo')?.textContent).toContain('Step 6 is for our team.');
    expect(q('diag-echo')?.textContent).not.toContain('$');
  });

  it('sends the results with the note, making a guest first when needed', async () => {
    stubFetch({
      'POST /api/diag': [
        { status: 401, body: { code: 'unauthorized', message: 'no identity' } },
        { status: 201, body: { id: 7 } },
      ],
      'GET /api/me': [{ status: 200, body: {} }],
    });
    await act(async () => render(<Diag />, root));
    await settle();
    const note = q('diag-note') as HTMLTextAreaElement;
    note.value = 'seated, bright room';
    await act(async () => void note.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => q('diag-send')!.click());
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/diag', 'GET /api/me', 'POST /api/diag']);
    const body = calls[2]!.body as { version: number; note: string; autoplay: { without_tap: { media: string } }; device: { webxr: boolean } };
    expect(body.version).toBe(1);
    expect(body.note).toBe('seated, bright room');
    expect(body.autoplay.without_tap.media).toBe('blocked');
    expect(body.device.webxr).toBe(false);
    expect(q('diag-sent')?.textContent).toContain('Sent. Result number 7.');
    expect(JSON.stringify(body).length).toBeLessThan(64 * 1024);
  });

  it('asks before the paid echo test, sends the dev key once on a double tap, and makes a guest first', async () => {
    history.replaceState(null, '', '/diag?dev=1');
    stubFetch({
      'POST /api/diag/echo': [
        { status: 401, body: { code: 'unauthorized', message: 'no identity' } },
        { status: 429, body: { code: 'fish_cap', message: 'The voice budget is used up.' } },
      ],
      'GET /api/me': [{ status: 200, body: {} }],
    });
    await act(async () => render(<Diag />, root));
    await settle();
    expect((q('diag-echo-run') as HTMLButtonElement).disabled).toBe(true);
    const key = q('diag-key') as HTMLInputElement;
    key.value = 'k1';
    await act(async () => void key.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => q('diag-echo-run')!.click());
    expect(calls.some((c) => c.path === '/api/diag/echo')).toBe(false);
    const confirm = q('diag-echo-confirm')!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await settle();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/diag/echo', 'GET /api/me', 'POST /api/diag/echo']);
    const echo = calls.find((c) => c.path === '/api/diag/echo')!;
    expect(echo.headers['x-dev-key']).toBe('k1');
    expect(root.textContent).toContain('fish_cap');
    expect(sessionStorage.getItem('ir.devKey')).toBe('k1');
  });
});
