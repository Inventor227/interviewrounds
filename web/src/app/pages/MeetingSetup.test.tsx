import { afterEach, describe, expect, it } from 'vitest';
import type { MeetingSetup } from '../../shared/types';
import { launchState } from '../launch';
import { $, $$, cleanup, click, renderApp, stubNavigator, typeInto, useFakeServer, waitFor } from '../test-utils';

const prepares = (server: ReturnType<typeof useFakeServer>) =>
  server.calls.filter((c) => c.method === 'POST' && c.path === '/api/meetings/prepare').map((c) => c.body as MeetingSetup);

describe('MeetingSetup', () => {
  afterEach(cleanup);

  it('setup_requires_goal_and_one_attendee', async () => {
    const server = useFakeServer();
    const root = await renderApp('/meeting/new');
    await click(root.querySelector('[data-test="template-custom"]'));
    await click($(root, 'prepare'));
    expect($(root, 'goal-error')).not.toBeNull();
    expect($(root, 'people-error')).not.toBeNull();
    expect(prepares(server)).toHaveLength(0);

    await typeInto($(root, 'goal'), 'Approval for a pilot');
    await click($(root, 'prepare'));
    expect($(root, 'goal-error')).toBeNull();
    expect($(root, 'people-error')).not.toBeNull();
    expect(prepares(server)).toHaveLength(0);

    await typeInto($(root, 'attendee-name'), 'Kim');
    await typeInto($(root, 'attendee-role'), 'Head of operations');
    await click($(root, 'prepare'));
    expect(prepares(server)).toHaveLength(1);
    expect(prepares(server)[0]).toMatchObject({
      template_id: null,
      goal: 'Approval for a pilot',
      attendees: [{ name: 'Kim', role: 'Head of operations' }],
    });
    expect($(root, 'prepared')).not.toBeNull();
  });

  it('setup_investor_pitch_prepares_in_one_tap', async () => {
    const server = useFakeServer();
    const root = await renderApp('/meeting/new');
    await click($(root, 'prepare'));
    const sent = prepares(server)[0]!;
    expect(sent.template_id).toBe('investor_pitch');
    expect(sent.attendees.map((a) => a.name)).toEqual(['Rhea', 'Tom']);
    expect(sent.attendees[0]!.likely_objections?.length).toBeGreaterThan(0);
    expect($$(root, 'plan-attendee')).toHaveLength(2);
  });

  it('setup_dropping_an_objection_updates_the_room_before_start', async () => {
    const r1 = stubNavigator('xr', undefined);
    const r2 = stubNavigator('mediaDevices', { getUserMedia: async () => ({ getTracks: () => [] }) });
    try {
      const server = useFakeServer();
      const root = await renderApp('/meeting/new');
      await click($(root, 'prepare'));
      await click($(root, 'mic-allow'));
      await waitFor(() => launchState().status === 'ready');
      const kept = prepares(server)[0]!.attendees[0]!.likely_objections!.length;
      expect(($(root, 'start-preview') as HTMLButtonElement).disabled).toBe(false);
      await click($$(root, 'objection-keep')[0]!);
      expect(($(root, 'start-preview') as HTMLButtonElement).disabled).toBe(true);
      await click($(root, 'apply-objections'));
      const second = prepares(server)[1]!;
      expect(second.attendees[0]!.likely_objections).toHaveLength(kept - 1);
      // The plan changed, so the session made for the old one is dropped: phase A again.
      expect(launchState().status).toBe('idle');
      expect(($(root, 'start-preview') as HTMLButtonElement).disabled).toBe(true);
      await click($(root, 'mic-allow'));
      await waitFor(() => launchState().status === 'ready');
      expect(($(root, 'start-preview') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      r1();
      r2();
    }
  });

  it('setup_starts_a_meeting_session_with_the_plan', async () => {
    const r1 = stubNavigator('xr', undefined);
    const r2 = stubNavigator('mediaDevices', { getUserMedia: async () => ({ getTracks: () => [] }) });
    try {
      const server = useFakeServer();
      const root = await renderApp('/meeting/new');
      await click($(root, 'prepare'));
      expect(($(root, 'start-preview') as HTMLButtonElement).disabled).toBe(true);
      await click($(root, 'mic-allow'));
      await waitFor(() => launchState().status === 'ready');
      expect(server.calls.find((c) => c.method === 'POST' && c.path === '/api/sessions')?.body).toMatchObject({
        mode: 'meeting',
        meeting_plan_id: 'mp_demo',
        length: 'short',
      });
      expect(launchState().status).toBe('ready');
      await click($(root, 'start-preview'));
      expect(location.pathname).toMatch(/^\/session\//);
    } finally {
      r1();
      r2();
    }
  });

  it('setup_shows_a_cap_when_prepare_is_refused', async () => {
    useFakeServer({
      routes: {
        'POST /api/meetings/prepare': () =>
          new Response(JSON.stringify({ code: 'judge_budget_reached', message: 'Full', resets_at: '2026-11-14T00:00:00Z' }), {
            status: 429,
          }),
      },
    });
    const root = await renderApp('/meeting/new');
    await click($(root, 'prepare'));
    expect($(root, 'cap-notice')?.dataset.reason).toBe('judge_budget_reached');
  });

  it('setup_shows_an_error_when_prepare_fails', async () => {
    useFakeServer({ routes: { 'POST /api/meetings/prepare': () => new Response('', { status: 503 }) } });
    const root = await renderApp('/meeting/new');
    await click($(root, 'prepare'));
    expect($(root, 'error')).not.toBeNull();
  });
});
