import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerEvents, PrepareInput, RoundController } from '../../session/controller';
import type { ControllerState } from '../../session/ports';
import { clearLiveRoom, setLiveRoom, type LiveRoom } from '../../session/room';
import { StageTimings } from '../../session/timings';
import { sessionRes } from '../../voice/testkit';
import { Emitter } from '../../voice/transport';
import { $, cleanup, click, renderApp, settle } from '../test-utils';
import { sameWords } from './Report';
import { startHref } from './Session';

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
  });

  it('a_round_lost_after_it_began_keeps_the_report', async () => {
    const { root, controller } = await mount('greeting');
    controller.go('live');
    controller.emit('error', { code: 'voice_lost' } as never);
    await settle();
    expect($(root, 'session-not-started')).toBeNull();
    expect($(root, 'session-error')!.querySelector('a')!.getAttribute('href')).toBe('/report/sess1');
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
