import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, DEV_KEY_STORE, RETRY_AFTER_MS } from './api';

type Call = { url: string; init: RequestInit };

function stubFetch(status: number, body: unknown, contentType = 'application/json') {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': contentType } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

describe('api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends_json_with_cookies', async () => {
    const calls = stubFetch(200, { session_id: 's1' });
    const res = await api.createSession({ mode: 'interview', round_id: 'r1', length: 'short', level: 'mid', style: 'neutral', voice: 'fake' });
    expect(res.session_id).toBe('s1');
    expect(calls[0]?.url).toBe('/api/sessions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ round_id: 'r1', voice: 'fake' });
  });

  it('fake_voice_sessions_carry_the_dev_key_and_real_ones_never_do', async () => {
    const req = { mode: 'interview', round_id: 'r1', length: 'short', level: 'mid', style: 'neutral' } as const;
    sessionStorage.setItem(DEV_KEY_STORE, 'k-123');
    try {
      const calls = stubFetch(200, { session_id: 's1' });
      await api.createSession({ ...req, voice: 'fake' });
      await api.createSession({ ...req, voice: 'fish' });
      expect(new Headers(calls[0]?.init.headers).get('x-dev-key')).toBe('k-123');
      expect(new Headers(calls[1]?.init.headers).get('x-dev-key')).toBeNull();
      sessionStorage.removeItem(DEV_KEY_STORE);
      await api.createSession({ ...req, voice: 'fake' });
      expect(new Headers(calls[2]?.init.headers).get('x-dev-key')).toBeNull();
    } finally {
      sessionStorage.removeItem(DEV_KEY_STORE);
    }
  });

  it('errors_carry_status_code_message', async () => {
    stubFetch(429, { code: 'GuestDailyLimit', message: 'Come back tomorrow', resets_at: '2026-11-14T00:00:00Z' });
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'GuestDailyLimit', message: 'Come back tomorrow' });
    expect((err as ApiError).body.resets_at).toBe('2026-11-14T00:00:00Z');
  });

  it('non_json_errors_still_become_api_errors', async () => {
    stubFetch(502, 'Bad gateway', 'text/html');
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_502' });
  });

  it('a_call_inside_a_round_is_made_once_more_after_a_502_503_or_504', async () => {
    vi.useFakeTimers();
    try {
      const answers = [new Response('swapping', { status: 503 }), new Response('{"voice":{"transport":"fake"}}', { status: 200 })];
      const fetchFn = vi.fn(async () => answers.shift()!);
      vi.stubGlobal('fetch', fetchFn);
      const join = api.joinPanelist('s1', 'p2', { opening_line: 'Hi' });
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS - 1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(join).resolves.toEqual({ voice: { transport: 'fake' } });
      expect(fetchFn).toHaveBeenCalledTimes(2);

      // Only once, and never for a call that starts a round (a refused start must show at once).
      const twice = [new Response('x', { status: 504 }), new Response('x', { status: 502 })];
      const f2 = vi.fn(async () => twice.shift()!);
      vi.stubGlobal('fetch', f2);
      const resume = api.resumeSession('s1').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS);
      expect(await resume).toMatchObject({ status: 502 });
      expect(f2).toHaveBeenCalledTimes(2);
      const f3 = vi.fn(async () => new Response('x', { status: 503 }));
      vi.stubGlobal('fetch', f3);
      await expect(api.createSession({ mode: 'interview', round_id: 'r', length: 'short', level: 'mid', style: 'neutral', voice: 'fish' })).rejects.toMatchObject({ status: 503 });
      expect(f3).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('empty_responses_resolve_undefined', async () => {
    const calls = stubFetch(204, undefined);
    await expect(api.endSession('s 1', 'user_ended')).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('/api/sessions/s%201/end');
  });

  it('query_params_are_encoded', async () => {
    const calls = stubFetch(200, []);
    await api.history('pm');
    await api.history();
    expect(calls.map((c) => c.url)).toEqual(['/api/me/history?role=pm', '/api/me/history']);
  });

  it('board_image_is_png_and_capped_at_2mb', async () => {
    const calls = stubFetch(204, undefined);
    await api.uploadBoardImage('s1', new Blob([new Uint8Array(10)], { type: 'image/png' }));
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('image/png');
    const big = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' });
    await expect(api.uploadBoardImage('s1', big)).rejects.toMatchObject({ status: 413 });
    expect(calls).toHaveLength(1);
  });

  it('non_json_success_is_a_bad_response', async () => {
    stubFetch(200, '<!doctype html><title>app</title>', 'text/html');
    await expect(api.me()).rejects.toMatchObject({ status: 200, code: 'bad_response' });
  });

  it('network_failure_is_an_api_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api.catalog()).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});
