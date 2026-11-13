import { afterEach, describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types';
import { $, cleanup, click, renderApp, settle, useFakeServer } from '../test-utils';

const puts = (server: ReturnType<typeof useFakeServer>) =>
  server.calls.filter((c) => c.method === 'PUT' && c.path === '/api/me/settings').map((c) => c.body as Settings);

describe('Settings', () => {
  afterEach(cleanup);

  it('settings_persist', async () => {
    const server = useFakeServer({ scenario: '1' });
    const before = server.state.me.settings;
    const root = await renderApp('/settings');
    await click(root.querySelector('[data-test="default_level-senior"]'));
    await click($(root, 'field-captions'));

    const sent = puts(server);
    expect(sent).toHaveLength(2);
    // The whole object goes up each time, with every earlier change kept.
    expect(sent[1]).toEqual({ ...before, default_level: 'senior', captions: true });
    expect(Object.keys(sent[1]!).sort()).toEqual([
      'avatar_brightness',
      'captions',
      'default_level',
      'default_role',
      'default_style',
      'dominant_hand',
      'practice_mode',
      'sfx_volume',
      'voice_speed',
    ]);
    expect($(root, 'save-state')?.dataset.state).toBe('saved');

    // A fresh load shows the saved values.
    const saved = server.state.me;
    cleanup();
    useFakeServer({ me: saved });
    const again = await renderApp('/settings');
    expect((again.querySelector('[data-test="default_level-senior"]') as HTMLInputElement).checked).toBe(true);
    expect(($(again, 'field-captions') as HTMLInputElement).checked).toBe(true);
  });

  it('settings_range_saves_when_released', async () => {
    const server = useFakeServer({ scenario: '1' });
    const root = await renderApp('/settings');
    const range = $(root, 'field-voice_speed') as HTMLInputElement;
    range.value = '1.1';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(2);
    expect(puts(server)).toHaveLength(0);
    range.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(puts(server)[0]?.voice_speed).toBe(1.1);
  });

  it('settings_show_an_error_when_saving_fails', async () => {
    useFakeServer({
      scenario: '1',
      routes: { 'PUT /api/me/settings': () => new Response('{"code":"boom","message":"x"}', { status: 500 }) },
    });
    const root = await renderApp('/settings');
    await click($(root, 'field-captions'));
    expect($(root, 'save-state')?.dataset.state).toBe('error');
    expect($(root, 'save-retry')).not.toBeNull();
  });

  it('settings_delete_needs_a_confirm', async () => {
    const server = useFakeServer({ scenario: '1' });
    const root = await renderApp('/settings');
    await click($(root, 'delete-data'));
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await click($(root, 'delete-cancel'));
    expect($(root, 'delete-confirm')).toBeNull();
    expect(document.activeElement).toBe($(root, 'delete-data'));
    await click($(root, 'delete-data'));
    await click($(root, 'delete-confirm-yes'));
    expect(server.calls.some((c) => c.method === 'DELETE' && c.path === '/api/me')).toBe(true);
    expect($(root, 'deleted')).not.toBeNull();
  });
});
