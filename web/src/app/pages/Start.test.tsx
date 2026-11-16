import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import type { CreateSessionReq } from '../../shared/types';
import { fakeMe, sessionResFor } from '../fake/server';
import { $, cleanup, click, renderApp, settle, stubNavigator, testRuntime, useFakeServer, waitFor } from '../test-utils';
import { versioned } from '../../net/bytes';
import { readyPeople, readyStep } from '../../session/readyProgress';

const restores: (() => void)[] = [];
const stub = (k: string, v: unknown) => restores.push(stubNavigator(k, v));

function fakeStream(): MediaStream {
  const track = { stop: vi.fn(), kind: 'audio' };
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

function micThat(result: 'grant' | 'deny' | 'none') {
  const getUserMedia = vi.fn(async () => {
    if (result === 'grant') return fakeStream();
    throw Object.assign(new Error('mic'), { name: result === 'deny' ? 'NotAllowedError' : 'NotFoundError' });
  });
  stub('mediaDevices', { getUserMedia });
  return getUserMedia;
}

const withHeadset = (ok: boolean) => stub('xr', { isSessionSupported: vi.fn(async () => ok) });
const creates = (server: ReturnType<typeof useFakeServer>) =>
  server.calls.filter((c) => c.method === 'POST' && c.path === '/api/sessions').map((c) => c.body as CreateSessionReq);
const enterBtn = (root: HTMLElement) => ($(root, 'start-round') ?? $(root, 'start-preview')) as HTMLButtonElement;
const launchOf = (root: HTMLElement) => $(root, 'ready')?.dataset.launch;
const settled = (root: HTMLElement) => waitFor(() => ['ready', 'failed'].includes(launchOf(root) ?? ''));

describe('Start', () => {
  afterEach(() => {
    cleanup();
    for (const r of restores.splice(0)) r();
  });

  it('start_shows_denied_state_when_mic_blocked', async () => {
    const server = useFakeServer({ scenario: '1' });
    micThat('deny');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'mic-denied')).toBeNull();
    await click($(root, 'mic-allow'));
    expect($(root, 'mic-step')?.dataset.state).toBe('denied');
    expect($(root, 'mic-denied')).not.toBeNull();
    expect(enterBtn(root).disabled).toBe(true);
    expect(creates(server)).toHaveLength(0);
  });

  it('start_shows_no_mic_state', async () => {
    useFakeServer({ scenario: '1' });
    micThat('none');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    expect($(root, 'mic-none')).not.toBeNull();
  });

  it('phase_a_on_the_mic_tap_prepares_without_entering_xr', async () => {
    const server = useFakeServer({ scenario: '1' });
    const gum = micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    expect(enterBtn(root).disabled).toBe(true);
    await click(enterBtn(root));
    expect(location.pathname).toBe('/round/sde.system_design.short');

    await click($(root, 'mic-allow'));
    await settled(root);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(creates(server)).toEqual([
      { mode: 'interview', round_id: 'sde.system_design.short', length: 'short', level: 'mid', style: 'neutral', voice: 'fish' },
    ]);
    expect(testRuntime.xrPreload).toHaveBeenCalledTimes(1);
    expect(testRuntime.xrEnter).not.toHaveBeenCalled();
    expect(launchOf(root)).toBe('ready');
    expect(enterBtn(root).disabled).toBe(false);
    expect($(root, 'hands-note')).not.toBeNull();
    expect($(root, 'mic-meter')).toBeNull();
  });

  it('getting_the_room_ready_shows_a_progress_bar_and_the_step', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    testRuntime.xrPreload.mockImplementation(async () => {
      readyStep('room');
      await settle();
      readyPeople(['Daniel'], []);
      await gate;
    });
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'ready-progress')).toBeNull();
    await click($(root, 'mic-allow'));
    await waitFor(() => $(root, 'ready-progress')?.dataset.step === 'people');

    const bar = root.querySelector('[role=progressbar]') as HTMLElement;
    expect(bar.getAttribute('aria-label')).toBe('Getting the room ready');
    // No percentage known: an indeterminate bar (no aria-valuenow).
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.classList.contains('progress-indeterminate')).toBe(true);
    const line = $(root, 'ready-step')!;
    expect(line.textContent).toBe('Bringing in Daniel');
    expect(line.getAttribute('aria-live')).toBe('polite');
    // The Enter button is described by the step line, and the mic tap button is gone while it loads.
    expect(enterBtn(root).getAttribute('aria-describedby')).toBe(line.id);
    expect(enterBtn(root).disabled).toBe(true);
    expect($(root, 'mic-allow')).toBeNull();

    release();
    await settled(root);
    expect($(root, 'ready-progress')).toBeNull();
    expect($(root, 'enter-note')?.textContent).toBe('Ready. Put on your headset.');
  });

  it('the_bar_shows_a_percentage_once_the_sizes_are_known', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    testRuntime.xrPreload.mockImplementation(async () => {
      readyPeople(['Daniel'], [versioned('/avatars/m02.glb')]);
      await gate;
    });
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    await waitFor(() => $(root, 'ready-progress')?.dataset.step === 'people');
    const bar = root.querySelector('[role=progressbar]') as HTMLElement;
    const now = Number(bar.getAttribute('aria-valuenow'));
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(100);
    release();
    await settled(root);
  });

  it('phase_b_requests_xr_inside_the_enter_tap', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    await settled(root);
    act(() => enterBtn(root).click());
    // Synchronously inside the tap: the XR request is already made, nothing awaited before it.
    expect(testRuntime.xrEnter).toHaveBeenCalledTimes(1);
    await settle();
    expect(location.pathname).toBe('/session/s_new_1');
    expect($(root, 'session-state')?.dataset.state).toBe('placing');
  });

  it('home_tap_does_phase_a_so_start_needs_only_enter', async () => {
    const server = useFakeServer({ scenario: '1' });
    const gum = micThat('grant');
    withHeadset(true);
    const root = await renderApp('/');
    await click($(root, 'try-quick'));
    expect(location.pathname).toBe('/round/sde.system_design.short');
    await settled(root);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(creates(server)).toHaveLength(1);
    expect(launchOf(root)).toBe('ready');
    act(() => enterBtn(root).click());
    expect(testRuntime.xrEnter).toHaveBeenCalledTimes(1);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('start_shows_denied_state_when_home_was_refused', async () => {
    const server = useFakeServer({ scenario: '1' });
    micThat('deny');
    withHeadset(true);
    const root = await renderApp('/');
    await click($(root, 'try-quick'));
    expect($(root, 'mic-denied')).not.toBeNull();
    expect(creates(server)).toHaveLength(0);
  });

  it('start_falls_back_to_preview_without_webxr', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    stub('xr', undefined);
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'headset-none')).not.toBeNull();
    expect($(root, 'qr')?.dataset.text).toContain('/round/sde.system_design.short');
    expect($(root, 'start-round')).toBeNull();
    await click($(root, 'mic-allow'));
    await settled(root);
    expect(testRuntime.xrEnter).not.toHaveBeenCalled();
    await click($(root, 'start-preview'));
    expect(location.pathname).toBe('/session/s_new_1');
  });

  it('start_falls_back_to_preview_when_ar_is_unsupported', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(false);
    const root = await renderApp('/round/sde.coding.short');
    expect($(root, 'headset-none')).not.toBeNull();
    expect($(root, 'start-preview')).not.toBeNull();
  });

  it('start_adjust_changes_level_and_style', async () => {
    const server = useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click(root.querySelector('[data-test="level-senior"]'));
    await click(root.querySelector('[data-test="style-tough"]'));
    await click($(root, 'mic-allow'));
    await settled(root);
    expect(creates(server)[0]).toMatchObject({ level: 'senior', style: 'tough' });
  });

  it('start_adjust_after_prepare_drops_the_prepared_round', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    await settled(root);
    expect(launchOf(root)).toBe('ready');
    await click(root.querySelector('[data-test="level-staff"]'));
    expect(launchOf(root)).toBe('none');
    expect(enterBtn(root).disabled).toBe(true);
  });

  it('start_prepare_failure_offers_another_try', async () => {
    let fail = true;
    const server = useFakeServer({
      scenario: '1',
      routes: {
        'POST /api/sessions': () =>
          fail ? new Response('', { status: 503 }) : sessionResFor('s_new_2', 'sde.system_design.short', fakeMe('1')),
      },
    });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    await settled(root);
    expect(launchOf(root)).toBe('failed');
    expect($(root, 'prepare-failed')).not.toBeNull();
    // The stream went to the round and was stopped: no live level is shown.
    expect($(root, 'mic-meter')).toBeNull();
    expect(enterBtn(root).disabled).toBe(true);
    fail = false;
    await click($(root, 'mic-allow'));
    await waitFor(() => launchOf(root) === 'ready');
    expect(server.calls.filter((c) => c.path === '/api/sessions')).toHaveLength(2);
  });

  it('try_again_after_a_room_load_failure_reuses_the_session', async () => {
    const server = useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    testRuntime.xrPreload.mockRejectedValueOnce(new Error('gl'));
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    await settled(root);
    expect(launchOf(root)).toBe('failed');
    await click($(root, 'mic-allow'));
    await waitFor(() => launchOf(root) === 'ready');
    expect(creates(server)).toHaveLength(1);
  });

  it('home_and_start_agree_on_preview_without_a_headset', async () => {
    const server = useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(false);
    const root = await renderApp('/');
    await click($(root, 'try-quick'));
    await settled(root);
    expect(launchOf(root)).toBe('ready');
    expect(($(root, 'start-preview') as HTMLButtonElement).disabled).toBe(false);
    expect(creates(server)).toHaveLength(1);
  });

  it('start_retry_posts_retry_in_phase_a', async () => {
    const server = useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short?retry=s_parent');
    expect($(root, 'retry-note')).not.toBeNull();
    await click($(root, 'mic-allow'));
    await settled(root);
    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/api/sessions/s_parent/retry')).toBe(true);
    expect(creates(server)).toHaveLength(0);
    expect(launchOf(root)).toBe('ready');
  });

  it('start_leaving_the_page_drops_the_prepared_round', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    await settled(root);
    await click(root.querySelector('a[href="/history"]'));
    const { launchState } = await import('../launch');
    expect(launchState().status).toBe('idle');
  });

  it('a_held_mic_survives_rerenders', async () => {
    useFakeServer({ scenario: '1' });
    micThat('grant');
    withHeadset(true);
    const track = { stop: vi.fn() };
    const { holdMic } = await import('../components/Ready');
    holdMic({ state: 'on', stream: { getTracks: () => [track] } as unknown as MediaStream });
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'mic-step')?.dataset.state).toBe('on');
    // Re-render the page a few times (Adjust changes): the held stream must stay live.
    await click(root.querySelector('[data-test="level-senior"]'));
    await click(root.querySelector('[data-test="style-warm"]'));
    expect($(root, 'mic-step')?.dataset.state).toBe('on');
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('start_shows_cap_notice_instead_of_enter', async () => {
    useFakeServer({ scenario: 'capped' });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'cap-notice')).not.toBeNull();
    expect($(root, 'start-round')).toBeNull();
  });

  it('start_says_when_a_round_does_not_exist', async () => {
    useFakeServer({ scenario: '1' });
    const root = await renderApp('/round/nope.short');
    expect($(root, 'round-missing')).not.toBeNull();
  });
});
