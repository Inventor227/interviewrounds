import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { peekLaunch, takeLaunch } from '../launch';
import { $, cleanup, click, renderApp, settle, stubNavigator, useFakeServer } from '../test-utils';

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

describe('Start', () => {
  beforeEach(() => {
    takeLaunch();
    useFakeServer({ scenario: '1' });
  });
  afterEach(() => {
    cleanup();
    for (const r of restores.splice(0)) r();
  });

  it('start_shows_denied_state_when_mic_blocked', async () => {
    micThat('deny');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'mic-denied')).toBeNull();
    await click($(root, 'mic-allow'));
    expect($(root, 'mic-step')?.dataset.state).toBe('denied');
    expect($(root, 'mic-denied')).not.toBeNull();
    expect(($(root, 'start-round') as HTMLButtonElement).disabled).toBe(true);
  });

  it('start_needs_the_mic_before_enter_the_room', async () => {
    const gum = micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    const enter = $(root, 'start-round') as HTMLButtonElement;
    expect(enter.disabled).toBe(true);
    await click(enter);
    expect(peekLaunch()).toBeNull();
    expect(gum).not.toHaveBeenCalled();
    await click($(root, 'mic-allow'));
    expect(gum).toHaveBeenCalledTimes(1);
    expect(($(root, 'start-round') as HTMLButtonElement).disabled).toBe(false);
    expect($(root, 'hands-note')).not.toBeNull();
  });

  it('start_skips_the_mic_tap_when_home_already_asked', async () => {
    const gum = micThat('grant');
    withHeadset(true);
    const root = await renderApp('/');
    await click($(root, 'try-quick'));
    expect(location.pathname).toBe('/round/sde.system_design.short');
    expect(gum).toHaveBeenCalledTimes(1);
    expect($(root, 'mic-step')?.dataset.state).toBe('on');
    await click($(root, 'start-round'));
    expect(peekLaunch()).toMatchObject({ kind: 'new', req: { round_id: 'sde.system_design.short', level: 'mid', style: 'neutral' } });
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('start_shows_denied_state_when_home_was_refused', async () => {
    micThat('deny');
    withHeadset(true);
    const root = await renderApp('/');
    await click($(root, 'try-quick'));
    expect($(root, 'mic-denied')).not.toBeNull();
  });

  it('start_shows_no_mic_state', async () => {
    micThat('none');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    expect($(root, 'mic-none')).not.toBeNull();
  });

  it('start_falls_back_to_preview_without_webxr', async () => {
    micThat('grant');
    stub('xr', undefined);
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'headset-none')).not.toBeNull();
    expect($(root, 'qr')?.dataset.text).toContain('/round/sde.system_design.short');
    expect($(root, 'start-round')).toBeNull();
    await click($(root, 'mic-allow'));
    await click($(root, 'start-preview'));
    expect(peekLaunch()).toMatchObject({ kind: 'new', preview: true, req: { mode: 'interview', round_id: 'sde.system_design.short', length: 'short' } });
    expect(location.pathname).toBe('/session/new');
  });

  it('start_falls_back_to_preview_when_ar_is_unsupported', async () => {
    micThat('grant');
    withHeadset(false);
    const root = await renderApp('/round/sde.coding.short');
    expect($(root, 'headset-none')).not.toBeNull();
    expect($(root, 'start-preview')).not.toBeNull();
  });

  it('start_hands_over_inside_the_tap_when_the_mic_is_on', async () => {
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click($(root, 'mic-allow'));
    expect($(root, 'mic-step')?.dataset.state).toBe('on');
    // No await between the tap and the hand-over: XR entry needs the tap's activation.
    act(() => $(root, 'start-round')!.click());
    const l = peekLaunch();
    expect(l).toMatchObject({ kind: 'new', preview: false, req: { level: 'mid', style: 'neutral', voice: 'fish' } });
    expect(l?.mic).toBeTruthy();
    await settle();
  });

  it('start_adjust_changes_level_and_style', async () => {
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    await click(root.querySelector('[data-test="level-senior"]'));
    await click(root.querySelector('[data-test="style-tough"]'));
    await click($(root, 'mic-allow'));
    await click($(root, 'start-round'));
    expect(peekLaunch()).toMatchObject({ req: { level: 'senior', style: 'tough' } });
  });

  it('start_retry_launches_a_retry_of_the_parent_session', async () => {
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short?retry=s_parent');
    expect($(root, 'retry-note')).not.toBeNull();
    await click($(root, 'mic-allow'));
    await click($(root, 'start-round'));
    expect(peekLaunch()).toMatchObject({ kind: 'retry', parentSessionId: 's_parent' });
  });

  it('start_shows_cap_notice_instead_of_start', async () => {
    cleanup();
    useFakeServer({ scenario: 'capped' });
    micThat('grant');
    withHeadset(true);
    const root = await renderApp('/round/sde.system_design.short');
    expect($(root, 'cap-notice')).not.toBeNull();
    expect($(root, 'start-round')).toBeNull();
  });

  it('start_says_when_a_round_does_not_exist', async () => {
    const root = await renderApp('/round/nope.short');
    expect($(root, 'round-missing')).not.toBeNull();
  });
});
