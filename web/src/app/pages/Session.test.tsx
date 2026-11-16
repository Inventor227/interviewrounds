import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerEvents, PrepareInput, RoundController } from '../../session/controller';
import type { ControllerState } from '../../session/ports';
import { clearLiveRoom, setLiveRoom, type LiveRoom } from '../../session/room';
import { StageTimings } from '../../session/timings';
import { sessionRes } from '../../voice/testkit';
import { Emitter } from '../../voice/transport';
import { fakeMe } from '../fake/server';
import { $, cleanup, click, renderApp, settle, useFakeServer } from '../test-utils';
import { sameWords } from './Report';
import { noticeLine, RESUMABLE_POLL_MS, startHref } from './Session';

const launchMock = vi.hoisted(() => ({ next: null as unknown }));
vi.mock('../launch', async (orig) => ({
  ...(await orig<typeof import('../launch')>()),
  takeLaunch: () => {
    const l = launchMock.next;
    launchMock.next = null;
    return l;
  },
}));

function fakeController(state: ControllerState) {
  const events = new Emitter<ControllerEvents>();
  const c = {
    state,
    started: false,
    notice: null as string | null,
    endedWhilePaused: false,
    session: sessionRes(),
    latencyHistory: [],
    on: events.on.bind(events),
    enter: vi.fn(async () => undefined),
    returnToRoom: vi.fn(async () => undefined),
    end: vi.fn(),
    dispose: vi.fn(async () => undefined),
    sendTypedTurn: vi.fn(),
    emit: events.emit.bind(events),
    go(s: ControllerState) {
      c.state = s;
      events.emit('state', s);
    },
  };
  return c;
}

function fakeRoom(): LiveRoom & { changed(): void } {
  const cbs = new Set<() => void>();
  return {
    host: document.createElement('div'),
    preview: false,
    timings: new StageTimings(),
    hasBoard: false,
    sessionLost: false,
    onChange: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
    changed: () => cbs.forEach((cb) => cb()),
  };
}

async function mount(state: ControllerState, input: PrepareInput = { kind: 'new', req: { mode: 'interview', round_id: 'beh_short', length: 'short', level: 'mid', style: 'neutral', voice: 'fake' } }) {
  const controller = fakeController(state);
  const room = fakeRoom();
  setLiveRoom(room);
  launchMock.next = { key: 'k', input, preview: false, title: 'Behavioral', controller: controller as unknown as RoundController, session: sessionRes() };
  const root = await renderApp('/session/sess1');
  return { root, controller, room };
}

describe('session page', () => {
  afterEach(() => {
    cleanup();
    const r = fakeRoom();
    setLiveRoom(r);
    clearLiveRoom(r);
  });

  it('leaving_the_headset_during_placement_returns_through_the_controller_and_end_works', async () => {
    const { root, controller, room } = await mount('placing');
    controller.emit('error', { code: 'placement_failed' } as never);
    room.sessionLost = true;
    room.changed();
    await settle();
    expect($(root, 'enter-room')).toBeNull(); // one way back, not two
    await click($(root, 'return-to-room'));
    expect(controller.returnToRoom).toHaveBeenCalledTimes(1);
    await click($(root, 'end-from-page'));
    expect(controller.end).toHaveBeenCalledTimes(1);
    // The controller reports the cancelled round: the page goes home.
    controller.go('failed');
    controller.emit('error', { code: 'cancelled' } as never);
    await settle();
    expect(location.pathname).toBe('/');
  });

  it('a_round_that_never_began_offers_the_start_again_not_a_report', async () => {
    const { root, controller } = await mount('greeting');
    controller.go('failed');
    controller.emit('error', { code: 'connect_failed' } as never);
    await settle();
    expect($(root, 'session-error')).toBeNull();
    const box = $(root, 'session-not-started')!;
    expect(box).not.toBeNull();
    expect(box.querySelector('[data-test="try-again"]')!.getAttribute('href')).toBe('/round/beh_short');
    expect(box.textContent).not.toMatch(/report/i);
    expect(box.textContent).toMatch(/Nothing was used up/);
  });

  it('nothing_was_used_up_is_only_said_when_the_round_never_started_on_the_server', async () => {
    const { root, controller } = await mount('greeting');
    controller.started = true; // the room had said hello before it failed
    controller.go('failed');
    controller.emit('error', { code: 'connect_failed' } as never);
    await settle();
    expect($(root, 'session-not-started')!.textContent).not.toMatch(/Nothing was used up/);
  });

  it('a_round_lost_after_it_began_keeps_the_report', async () => {
    const { root, controller } = await mount('greeting');
    controller.go('live');
    // A lost voice is not the end of the round any more (the room gets a new one): nothing fatal shows.
    controller.emit('error', { code: 'voice_lost' } as never);
    await settle();
    expect($(root, 'session-error')).toBeNull();
    controller.emit('error', { code: 'socket_terminal' } as never);
    await settle();
    expect($(root, 'session-not-started')).toBeNull();
    expect($(root, 'session-error')!.querySelector('a')!.getAttribute('href')).toBe('/report/sess1');
  });

  it('xr_session_ended_while_paused_offers_resume_on_2d', async () => {
    // The pause budget on the server says how long the round is held: 9 minutes here.
    const me = fakeMe('resume');
    me.resumable = { session_id: 'sess1', round_title: 'Behavioral', expires_at: new Date(Date.now() + 9 * 60_000).toISOString(), paused: true };
    useFakeServer({ me });
    const { root, controller, room } = await mount('live');
    controller.go('paused'); // the headset went to sleep: the controller holds the round
    room.sessionLost = true;
    room.changed();
    await settle();
    const offer = $(root, 'resume-offer')!;
    expect(offer.textContent).toMatch(/Your round is paused/);
    expect($(root, 'resume-left')!.textContent).toMatch(/^8:5\d$|^9:00$/);
    expect($(root, 'return-to-room')).toBeNull();
    expect($(root, 'session-state')).toBeNull(); // one message, not two
    await click($(root, 'resume-round'));
    // Back into the headset, the desk again, then the round carries on: all the controller's.
    expect(controller.returnToRoom).toHaveBeenCalledTimes(1);
    await click($(root, 'end-from-page'));
    expect(controller.end).toHaveBeenCalledTimes(1);
    // Back in the room: the offer goes away.
    room.sessionLost = false;
    controller.go('live');
    room.changed();
    await settle();
    expect($(root, 'resume-offer')).toBeNull();
  });

  it('the_page_never_ends_a_round_the_server_still_holds', async () => {
    // The first read of /api/me does not name the round yet (the pause is still on its way to the server).
    const me = fakeMe('1');
    const server = useFakeServer({ me });
    const { root, controller, room } = await mount('live');
    vi.useFakeTimers();
    try {
      controller.go('paused');
      room.sessionLost = true;
      room.changed();
      await settle();
      // No deadline known: none is made up, and nothing counts down to an end.
      expect($(root, 'resume-offer')).not.toBeNull();
      expect($(root, 'resume-left')).toBeNull();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await settle();
      expect($(root, 'resume-offer')).not.toBeNull();
      expect(controller.end).not.toHaveBeenCalled();
      // The server now lists it, held for six more minutes: the next read shows that.
      server.state.me = { ...server.state.me, resumable: { session_id: 'sess1', round_title: 'Behavioral', expires_at: new Date(Date.now() + 6 * 60_000).toISOString(), paused: true } };
      await vi.advanceTimersByTimeAsync(RESUMABLE_POLL_MS);
      await settle();
      expect($(root, 'resume-left')!.textContent).toMatch(/^5:\d\d$|^6:00$/);
      // Even past the deadline the page ends nothing: the server's own end comes over the socket.
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      await settle();
      expect(controller.end).not.toHaveBeenCalled();
      expect($(root, 'resume-round')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a_hand_over_that_did_not_happen_keeps_the_round_view_up', async () => {
    // A swap whose new voice did not join: the old voice carries on and the server asks again.
    const { root, controller } = await mount('live');
    controller.emit('error', { code: 'handover_failed' } as never);
    await settle();
    expect($(root, 'session-error')).toBeNull();
    expect($(root, 'session-not-started')).toBeNull();
    expect($(root, 'session-state')!.dataset.state).toBe('live');
    // A real loss of the round still shows.
    controller.emit('error', { code: 'socket_terminal' } as never);
    await settle();
    expect($(root, 'session-error')).not.toBeNull();
  });

  it('a_held_round_is_not_shown_as_lost_when_a_voice_reported_an_error', async () => {
    const { root, controller } = await mount('live');
    controller.go('paused');
    controller.emit('error', { code: 'connect_failed' } as never);
    await settle();
    expect($(root, 'session-error')).toBeNull();
    // And not once the round runs again after the Resume in the headset.
    controller.go('live');
    await settle();
    expect($(root, 'session-error')).toBeNull();
    expect($(root, 'session-state')!.dataset.state).toBe('live');
  });

  it('pause_budget_exhausted_shows_report', async () => {
    const { root, controller, room } = await mount('live');
    controller.go('paused');
    room.sessionLost = true;
    room.changed();
    await settle();
    expect($(root, 'resume-offer')).not.toBeNull();
    // The server ended the round: ten minutes of pauses were used up.
    controller.endedWhilePaused = true;
    controller.go('ending');
    await settle();
    expect($(root, 'resume-offer')).toBeNull();
    expect($(root, 'ended-paused')!.textContent).toBe('The round ended while paused. Writing your report.');
    expect($(root, 'see-report')!.getAttribute('href')).toBe('/report/sess1');
    controller.go('scoring');
    await settle();
    expect($(root, 'ended-paused')).not.toBeNull();
    expect($(root, 'session-error')).toBeNull();
  });

  it('the_history_button_of_the_slow_scoring_card_goes_to_history', async () => {
    const { controller } = await mount('scoring');
    controller.emit('action', 'history');
    await settle();
    expect(location.pathname).toBe('/history');
  });

  it('a_card_of_the_room_reads_as_one_line_on_the_page', () => {
    expect(noticeLine({ title: 'Welcome back', detail: "Resume when you're ready." })).toBe("Welcome back. Resume when you're ready.");
    expect(noticeLine({ title: 'Reconnecting…', detail: 'Your progress is saved.' })).toBe('Reconnecting… Your progress is saved.');
    expect(noticeLine({ title: 'Your interviewer is reconnecting…', detail: '' })).toBe('Your interviewer is reconnecting…');
  });

  it('try_again_goes_back_to_the_start_the_round_came_from', () => {
    const session = sessionRes();
    expect(startHref({ session, input: { kind: 'resume', sessionId: 's 1', voice: 'fish' } })).toBe('/resume/s%201');
    expect(startHref({ session, input: { kind: 'retry', parentSessionId: 'p1', voice: 'fish' } })).toBe('/round/beh_short?retry=p1');
    expect(startHref({ session, input: { kind: 'new', req: { mode: 'meeting', meeting_plan_id: 'm', length: 'short', level: 'mid', style: 'neutral', voice: 'fish' } } })).toBe('/meeting/new');
  });

  it('the_report_says_not_enough_signal_once', () => {
    expect(sameWords('Not enough signal yet.', 'Not enough signal yet')).toBe(true);
    expect(sameWords('You covered scale well.', 'Not enough signal yet')).toBe(false);
  });
});
